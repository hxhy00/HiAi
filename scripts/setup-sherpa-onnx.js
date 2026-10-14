#!/usr/bin/env node
/**
 * Prepare the bundled sherpa-onnx SenseVoice sidecar under resources/sherpa-onnx.
 *
 * FR-3 (see specs/refactors/de-server-dependency/) replaces the server-backed
 * realtime ASR with local SenseVoice inference driven by a prebuilt
 * sherpa-onnx binary. This script is the packaging entry point that fetches:
 *
 *   - the sherpa-onnx prebuilt executable for the target platform/arch
 *     (internal target `mac-arm64` / `win-x64`; the upstream asset is resolved
 *     through SHERPA_ONNX_ASSET_SUFFIX because the release names differ), and
 *   - the SenseVoice Small int8 ONNX model bundle.
 *
 * U-9 decision: the model ships WITH the installer (no first-use download), so
 * the default flow is to place both the binary and the model under
 * `resources/sherpa-onnx/` at build time; the runtime never downloads anything.
 *
 * Environment overrides (all optional):
 *   LOBSTERAI_SHERPA_ONNX_ARCHIVE   local .tar.bz2/.zip of the sherpa-onnx release
 *   LOBSTERAI_SHERPA_ONNX_URL       download URL for the sherpa-onnx release archive
 *   LOBSTERAI_SENSEVOICE_ARCHIVE    local .tar.bz2/.zip of the SenseVoice model bundle
 *   LOBSTERAI_SENSEVOICE_URL        download URL for the SenseVoice model bundle
 *   LOBSTERAI_SHERPA_ONNX_TARGET    force a target (e.g. mac-arm64, win-x64)
 *
 * Layout produced under resources/sherpa-onnx/:
 *   bin/<target>/sherpa-onnx-offline            (or sherpa-onnx-offline.exe)
 *   bin/lib/libonnxruntime.*.dylib              (POSIX: loaded via @rpath ../lib)
 *   model/sense-voice/model.int8.onnx
 *   model/sense-voice/tokens.txt
 *
 * The runtime side (src/main/libs/senseVoice) only ever reads from that layout;
 * it verifies the files exist and reports "unavailable" when they do not.
 *
 * Packaged builds need no setup: `resources/sherpa-onnx` is shipped inside the
 * installer through electron-builder's extraResources, so end users get the
 * sidecar and the model out of the box. This script exists for the developer
 * checkout only, and is self-healing: a partially prepared tree (e.g. the
 * executable present but its dylibs missing) is re-extracted instead of being
 * trusted.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { spawnSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'resources', 'sherpa-onnx');
const DOWNLOAD_CACHE_DIR = path.join(PROJECT_ROOT, 'resources', '.sherpa-onnx-cache');

const SHERPA_ONNX_VERSION = process.env.LOBSTERAI_SHERPA_ONNX_VERSION || '1.10.30';
const SENSEVOICE_MODEL_NAME = process.env.LOBSTERAI_SENSEVOICE_MODEL || 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17';

// Both releases live on the upstream GitHub releases / model release pages.
// Mirrors can be injected through the *_URL env vars for offline or restricted
// networks; the defaults are used for the standard build pipeline.
const SHERPA_ONNX_BASE_URL = (process.env.LOBSTERAI_SHERPA_ONNX_BASE_URL
  || `https://github.com/k2-fsa/sherpa-onnx/releases/download/v${SHERPA_ONNX_VERSION}`).replace(/\/+$/, '');
const SENSEVOICE_BASE_URL = (process.env.LOBSTERAI_SENSEVOICE_BASE_URL
  || 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models').replace(/\/+$/, '');

const SHERPA_ONNX_EXECUTABLE = {
  'mac-arm64': 'sherpa-onnx-offline',
  'mac-x64': 'sherpa-onnx-offline',
  'win-x64': 'sherpa-onnx-offline.exe',
  'linux-x64': 'sherpa-onnx-offline',
  'linux-arm64': 'sherpa-onnx-offline',
};

/**
 * Upstream release asset suffix per target.
 *
 * The upstream naming does NOT follow our `bin/<target>` layout: on macOS the
 * only bundles that contain the `sherpa-onnx-offline` CLI are the
 * `osx-universal2-*` ones (there is no `-mac-arm64` asset), while Linux/Windows
 * use the `-<os>-<arch>-shared` suffix. Our runtime layout stays
 * `bin/<target>/`, so the two concepts are kept separate here.
 */
const SHERPA_ONNX_ASSET_SUFFIX = {
  'mac-arm64': 'osx-universal2-shared',
  'mac-x64': 'osx-universal2-shared',
  'win-x64': 'win-x64-shared',
  'linux-x64': 'linux-x64-shared',
  'linux-arm64': 'linux-aarch64-shared',
};

const REQUIRED_MODEL_FILES = [
  'model.int8.onnx',
  'tokens.txt',
];

function log(message) {
  console.log(`[setup-sherpa-onnx] ${message}`);
}

function warn(message) {
  console.warn(`[setup-sherpa-onnx] ${message}`);
}

function resolveTarget() {
  const forced = (process.env.LOBSTERAI_SHERPA_ONNX_TARGET || '').trim();
  if (forced) return forced;

  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : process.arch;
  if (process.platform === 'darwin') return `mac-${arch}`;
  if (process.platform === 'win32') return `win-${arch}`;
  if (process.platform === 'linux') return `linux-${arch}`;
  return `${process.platform}-${arch}`;
}

function isNonEmptyFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

/**
 * Whether a path is a symlink whose target can still be resolved.
 *
 * `isNonEmptyFile` follows links, so a *broken* symlink makes it return false —
 * which is correct for a required file, but wrong for the `libonnxruntime
 * .dylib -> libonnxruntime.1.17.1.dylib` alias: upstream ships that alias as a
 * symlink, and a tree prepared from an unpacked release keeps it as one. Such
 * an alias is fine; a dangling one (pointing at a deleted temp tree) is not,
 * because it is what ends up breaking users after packaging.
 */
function isResolvableSymlink(filePath) {
  try {
    if (!fs.lstatSync(filePath).isSymbolicLink()) return false;
    return fs.existsSync(fs.realpathSync(filePath));
  } catch {
    return false;
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

async function downloadArchive(url, destination) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed (${response.status} ${response.statusText}) for ${url}`);
  }

  ensureDir(path.dirname(destination));
  const tmpFile = `${destination}.download`;
  try {
    const stream = fs.createWriteStream(tmpFile);
    await pipeline(Readable.fromWeb(response.body), stream);
    if (!isNonEmptyFile(tmpFile)) {
      throw new Error('Downloaded archive is empty.');
    }
    fs.renameSync(tmpFile, destination);
  } catch (error) {
    try {
      fs.rmSync(tmpFile, { force: true });
    } catch {
      // Ignore cleanup error.
    }
    throw error;
  }
}

// Extraction uses the host `tar` followed by a `bzip2 -d` fallback. sherpa-onnx
// releases are .tar.bz2; model bundles can be .tar.bz2 or .zip. We deliberately
// avoid adding a new npm dependency to keep the toolchain unchanged.
function extractArchive(archivePath, destDir) {
  ensureDir(destDir);
  const lower = archivePath.toLowerCase();

  if (lower.endsWith('.zip')) {
    const result = spawnSync('unzip', ['-o', '-q', archivePath, '-d', destDir], {
      stdio: 'pipe',
      encoding: 'utf-8',
    });
    if (result.status !== 0) {
      throw new Error(`unzip failed: ${(result.stderr || result.stdout || '').trim()}`);
    }
    return;
  }

  // .tar.bz2 / .tar.gz
  const result = spawnSync('tar', ['-xf', archivePath, '-C', destDir], {
    stdio: 'pipe',
    encoding: 'utf-8',
  });
  if (result.status !== 0) {
    throw new Error(`tar extraction failed: ${(result.stderr || result.stdout || '').trim()}`);
  }
}

function findFileRecursively(rootDir, fileName) {
  const queue = [rootDir];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(full);
      } else if (entry.name === fileName) {
        return full;
      }
    }
  }
  return null;
}

async function resolveLocalOrDownload(localEnvValue, defaultFileName, baseUrl) {
  const local = typeof localEnvValue === 'string' ? localEnvValue.trim() : '';
  if (local) {
    const resolved = path.isAbsolute(local) ? local : path.resolve(process.cwd(), local);
    if (!isNonEmptyFile(resolved)) {
      throw new Error(`Configured local archive does not exist: ${resolved}`);
    }
    log(`Using local archive: ${resolved}`);
    return resolved;
  }

  const cached = path.join(DOWNLOAD_CACHE_DIR, defaultFileName);
  if (isNonEmptyFile(cached)) {
    log(`Using cached archive: ${cached}`);
    return cached;
  }

  const url = `${baseUrl}/${defaultFileName}`;
  log(`Downloading ${url}`);
  await downloadArchive(url, cached);
  const sizeMB = (fs.statSync(cached).size / 1024 / 1024).toFixed(1);
  log(`Downloaded ${defaultFileName} (${sizeMB} MB)`);
  return cached;
}

/**
 * Shared libraries a prepared target needs, resolved relative to OUTPUT_DIR.
 *
 * The "*_shared" bundles keep these in a sibling `lib/` directory; the macOS
 * executables look them up via `@rpath` as `bin/<target>/../lib/<name>`, i.e.
 * `bin/lib/`. Returning paths (not just names) keeps the completeness check
 * honest for every platform instead of hard-coding one layout.
 */
function requiredSharedLibraryPaths() {
  return [
    path.join(OUTPUT_DIR, 'bin', 'lib', 'libonnxruntime.1.17.1.dylib'),
  ];
}

/**
 * Whether a target is fully prepared: the executable AND every shared library
 * it loads at startup. Checking only the executable is what let a half-copied
 * sidecar (binary present, dylib missing) masquerade as "already prepared" and
 * fail at runtime with `dyld: Library not loaded`.
 *
 * Each required dylib is accepted either as a real file or as a resolvable
 * symlink. A *dangling* symlink (the historical copy bug produced
 * `libonnxruntime.dylib -> <deleted temp dir>/...`) fails both checks, so a
 * broken tree is re-extracted instead of being trusted and packaged.
 */
function isBinaryPrepared(target, executableName) {
  const finalExecutable = path.join(OUTPUT_DIR, 'bin', target, executableName);
  if (!isNonEmptyFile(finalExecutable)) return false;

  const needsSharedLibs = process.platform !== 'win32';
  if (!needsSharedLibs) return true;

  const requiredLibsPresent = requiredSharedLibraryPaths()
    .every((p) => isNonEmptyFile(p) || isResolvableSymlink(p));
  if (!requiredLibsPresent) return false;

  // Guard against any other dangling symlink left in bin/lib/ from an older
  // bad copy, even if it is not one of the currently required names.
  const libDir = path.join(OUTPUT_DIR, 'bin', 'lib');
  if (!hasNoDanglingSymlinks(libDir)) return false;

  return true;
}

/**
 * Replace every symlink under `dir` with a real copy of its target bytes.
 *
 * Returns the number of links materialized. Symlinks whose target cannot be
 * resolved are left untouched for the checker to reject; that path only happens
 * if the extraction tree was already broken.
 */
function materializeSymlinks(dir) {
  let count = 0;
  if (!fs.existsSync(dir)) return count;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      let real;
      try {
        real = fs.realpathSync(full);
      } catch {
        continue;
      }
      if (!fs.existsSync(real)) continue;
      const tmp = `${full}.materialize.tmp`;
      fs.copyFileSync(real, tmp);
      fs.rmSync(full, { force: true });
      fs.renameSync(tmp, full);
      // Keep the executable bit that shared libraries rely on.
      fs.chmodSync(full, 0o755);
      count += 1;
    } else if (entry.isDirectory()) {
      count += materializeSymlinks(full);
    }
  }
  return count;
}

/**
 * Recursively check that no entry under `dir` is a symlink that cannot be
 * resolved. Used to reject a previously-broken lib directory so it gets
 * re-extracted rather than shipped.
 */
function hasNoDanglingSymlinks(dir) {
  if (!fs.existsSync(dir)) return true;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return true;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink() && !isResolvableSymlink(full)) return false;
    if (entry.isDirectory() && !hasNoDanglingSymlinks(full)) return false;
  }
  return true;
}

async function prepareBinaries(target, required) {
  const executableName = SHERPA_ONNX_EXECUTABLE[target];
  if (!executableName) {
    throw new Error(`Unsupported sherpa-onnx target: ${target}`);
  }

  const finalBinDir = path.join(OUTPUT_DIR, 'bin', target);
  const finalExecutable = path.join(finalBinDir, executableName);
  if (isBinaryPrepared(target, executableName)) {
    log(`Binary already prepared: ${finalExecutable}`);
    return;
  }

  const assetSuffix = SHERPA_ONNX_ASSET_SUFFIX[target];
  if (!assetSuffix) {
    throw new Error(`No upstream sherpa-onnx release asset is mapped for target: ${target}`);
  }
  const archiveName = `sherpa-onnx-v${SHERPA_ONNX_VERSION}-${assetSuffix}.tar.bz2`;
  let archivePath;
  try {
    archivePath = await resolveLocalOrDownload(
      process.env.LOBSTERAI_SHERPA_ONNX_ARCHIVE,
      archiveName,
      SHERPA_ONNX_BASE_URL,
    );
  } catch (error) {
    if (required) throw error;
    warn(`sherpa-onnx binary is not available (${error instanceof Error ? error.message : String(error)}); skipping.`);
    return;
  }

  const tempDir = fs.mkdtempSync(path.join(PROJECT_ROOT, 'tmp-sherpa-onnx-'));
  try {
    extractArchive(archivePath, tempDir);
    const found = findFileRecursively(tempDir, executableName);
    if (!found) {
      throw new Error(`Could not find ${executableName} inside ${archivePath}`);
    }
    // A previous partial extraction may have left a half-populated directory
    // (exactly the bug this self-heal path exists for); start from a clean slate
    // so stale files can never be mistaken for a valid install.
    fs.rmSync(finalBinDir, { recursive: true, force: true });
    ensureDir(finalBinDir);
    // Copy the whole directory that contains the executable so sibling shared
    // libraries (libonnxruntime etc.) stay next to it.
    //
    // `dereference: true` is REQUIRED: upstream release bundles ship their
    // dylibs as symlinks into the unpacked release tree (e.g. `libonnxruntime
    // .dylib -> <temp>/.../libonnxruntime.1.17.1.dylib`). A default copy would
    // preserve those links verbatim, and once the temp tree is deleted the
    // copied link is broken — the installer would then ship a dangling symlink
    // and dyld would fail at runtime with "Library not loaded". Materializing
    // real files here keeps the packaged sidecar self-contained.
    const sourceDir = path.dirname(found);
    fs.cpSync(sourceDir, finalBinDir, { recursive: true, force: true, errorOnExist: false, dereference: true });

    // The "*_shared" release bundles keep their dylibs in a sibling `lib/`
    // directory rather than inside `bin/`. On macOS the executables resolve
    // their dependencies through `@rpath` as `../lib/<name>.dylib`, so the
    // libraries must land in `bin/lib/` (i.e. one level above `bin/<target>/`).
    const sourceLibDir = path.join(path.dirname(sourceDir), 'lib');
    if (fs.existsSync(sourceLibDir)) {
      const finalLibDir = path.join(OUTPUT_DIR, 'bin', 'lib');
      // Wipe the target first: `bin/lib` is a *sibling* of `bin/<target>`, so
      // the earlier `finalBinDir` cleanup does not touch it. `cpSync` with
      // `dereference: true` refuses to overwrite an existing directory
      // (EEXIST), and stale entries here are exactly the dangling symlinks we
      // are trying to eliminate.
      fs.rmSync(finalLibDir, { recursive: true, force: true });
      ensureDir(finalLibDir);
      fs.cpSync(sourceLibDir, finalLibDir, { recursive: true, force: true, errorOnExist: false, dereference: true });
      // `dereference` is not enough on its own: upstream keeps the alias
      // `libonnxruntime.dylib` as a symlink to a similarly-linked sibling, and
      // chains are preserved as links rather than materialized. Force every
      // symlink in the destination back to its real bytes so the packaged tree
      // has no dependency on the (soon deleted) extraction directory.
      const materialized = materializeSymlinks(finalLibDir);
      log(`Prepared shared libraries: ${finalLibDir}${materialized ? ` (materialized ${materialized} symlink(s))` : ''}`);
    }

    if (!executableName.endsWith('.exe')) {
      try {
        fs.chmodSync(finalExecutable, 0o755);
      } catch {
        // Ignore chmod failures on non-POSIX filesystems.
      }
    }
    log(`Prepared binary: ${finalExecutable}`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function prepareModel(required) {
  const finalModelDir = path.join(OUTPUT_DIR, 'model', 'sense-voice');
  const allPresent = REQUIRED_MODEL_FILES.every(file => isNonEmptyFile(path.join(finalModelDir, file)));
  if (allPresent) {
    log(`Model already prepared: ${finalModelDir}`);
    return;
  }

  const archiveName = `${SENSEVOICE_MODEL_NAME}.tar.bz2`;
  let archivePath;
  try {
    archivePath = await resolveLocalOrDownload(
      process.env.LOBSTERAI_SENSEVOICE_ARCHIVE,
      archiveName,
      SENSEVOICE_BASE_URL,
    );
  } catch (error) {
    if (required) throw error;
    warn(`SenseVoice model is not available (${error instanceof Error ? error.message : String(error)}); skipping.`);
    return;
  }

  const tempDir = fs.mkdtempSync(path.join(PROJECT_ROOT, 'tmp-sensevoice-'));
  try {
    extractArchive(archivePath, tempDir);
    ensureDir(finalModelDir);
    for (const fileName of REQUIRED_MODEL_FILES) {
      const found = findFileRecursively(tempDir, fileName);
      if (!found) {
        throw new Error(`Could not find ${fileName} inside ${archivePath}`);
      }
      fs.copyFileSync(found, path.join(finalModelDir, fileName));
    }
    // Optional assets some bundles ship with; copy when present but do not fail.
    for (const optional of ['README.md', 'test_wavs']) {
      const found = findFileRecursively(tempDir, optional);
      if (!found) continue;
      const target = path.join(finalModelDir, optional);
      if (fs.statSync(found).isDirectory()) {
        fs.cpSync(found, target, { recursive: true, force: true });
      } else {
        fs.copyFileSync(found, target);
      }
    }
    log(`Prepared model: ${finalModelDir}`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  const required = args.includes('--required');
  const target = resolveTarget();

  log(`Target: ${target}${required ? ' (required)' : ''}`);
  ensureDir(OUTPUT_DIR);

  await prepareBinaries(target, required);
  await prepareModel(required);

  const executable = path.join(OUTPUT_DIR, 'bin', target, SHERPA_ONNX_EXECUTABLE[target]);
  const model = path.join(OUTPUT_DIR, 'model', 'sense-voice', 'model.int8.onnx');
  const tokens = path.join(OUTPUT_DIR, 'model', 'sense-voice', 'tokens.txt');

  const missing = [];
  if (!isNonEmptyFile(executable)) missing.push(executable);
  if (process.platform !== 'win32') {
    for (const lib of requiredSharedLibraryPaths()) {
      if (!isNonEmptyFile(lib)) missing.push(lib);
    }
  }
  if (!isNonEmptyFile(model)) missing.push(model);
  if (!isNonEmptyFile(tokens)) missing.push(tokens);

  if (missing.length > 0) {
    if (required) {
      throw new Error(`sherpa-onnx sidecar is incomplete; missing:\n  ${missing.join('\n  ')}`);
    }
    warn(`sherpa-onnx sidecar is incomplete; voice input will be disabled at runtime. Missing:\n  ${missing.join('\n  ')}`);
    return;
  }

  log(`Sidecar ready under ${OUTPUT_DIR}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[setup-sherpa-onnx] ERROR:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

module.exports = {
  resolveTarget,
  isBinaryPrepared,
  requiredSharedLibraryPaths,
  SHERPA_ONNX_EXECUTABLE,
  SHERPA_ONNX_ASSET_SUFFIX,
  REQUIRED_MODEL_FILES,
};
