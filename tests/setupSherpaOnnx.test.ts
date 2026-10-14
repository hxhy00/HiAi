import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

const {
  isBinaryPrepared,
  requiredSharedLibraryPaths,
  resolveTarget,
  SHERPA_ONNX_ASSET_SUFFIX,
  SHERPA_ONNX_EXECUTABLE,
  REQUIRED_MODEL_FILES,
} = require('../scripts/setup-sherpa-onnx.js');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'resources', 'sherpa-onnx');

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * FR-3 packaging correctness: the download asset names do not follow our
 * internal `bin/<target>` layout. macOS only publishes `osx-universal2-*`
 * bundles, so an unmapped target silently produced a 404 and a greyed-out
 * voice button.
 */
describe('sherpa-onnx release asset mapping', () => {
  test('maps every supported target to an upstream asset suffix', () => {
    for (const target of Object.keys(SHERPA_ONNX_EXECUTABLE)) {
      expect(SHERPA_ONNX_ASSET_SUFFIX[target], `missing asset suffix for ${target}`).toBeTruthy();
    }
  });

  test('uses the osx-universal2 bundle for both macOS architectures', () => {
    expect(SHERPA_ONNX_ASSET_SUFFIX['mac-arm64']).toBe('osx-universal2-shared');
    expect(SHERPA_ONNX_ASSET_SUFFIX['mac-x64']).toBe('osx-universal2-shared');
  });

  test('keeps the runtime layout distinct from the upstream asset name', () => {
    // Runtime still resolves bin/<target>/<exe>; only the download URL differs.
    expect(resolveTarget()).toBeTruthy();
    expect(SHERPA_ONNX_EXECUTABLE['win-x64']).toBe('sherpa-onnx-offline.exe');
    expect(SHERPA_ONNX_ASSET_SUFFIX['win-x64']).toBe('win-x64-shared');
  });
});

/**
 * The sidecar is loaded through `@rpath` as `../lib/<name>.dylib`, i.e.
 * `bin/lib/`. Checking only the executable let a half-copied tree pass as
 * "already prepared" and then die at runtime with `dyld: Library not loaded`,
 * which surfaced to users as "no valid speech was recognized".
 */
describe('sherpa-onnx sidecar completeness (self-heal)', () => {
  test('lists the onnxruntime dylib that the executables dlopen', () => {
    const libs = requiredSharedLibraryPaths();
    expect(libs.length).toBeGreaterThan(0);
    expect(libs.some(lib => path.basename(lib) === 'libonnxruntime.1.17.1.dylib')).toBe(true);
    for (const lib of libs) {
      expect(path.relative(OUTPUT_DIR, lib)).toBe(path.join('bin', 'lib', path.basename(lib)));
    }
  });

  test('reports an executable without its shared libraries as unprepared', () => {
    const finalBinDir = path.join(OUTPUT_DIR, 'bin', 'mac-arm64');
    const finalLib = requiredSharedLibraryPaths()[0];
    const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sherpa-lib-backup-'));
    tempDirs.push(backupDir);
    const backup = path.join(backupDir, path.basename(finalLib));

    const libExisted = fs.existsSync(finalLib);
    const exeExisted = fs.existsSync(finalBinDir);
    if (!libExisted || !exeExisted) {
      // The developer checkout has not run setup yet; nothing to assert against.
      expect(isBinaryPrepared('mac-arm64', 'sherpa-onnx-offline')).toBe(false);
      return;
    }

    fs.renameSync(finalLib, backup);
    try {
      expect(isBinaryPrepared('mac-arm64', 'sherpa-onnx-offline')).toBe(false);
    } finally {
      fs.renameSync(backup, finalLib);
    }

    expect(isBinaryPrepared('mac-arm64', 'sherpa-onnx-offline')).toBe(true);
  });

  test('treats a missing executable as unprepared', () => {
    expect(isBinaryPrepared('mac-arm64', 'definitely-not-an-executable')).toBe(false);
  });
});

describe('sherpa-onnx model requirements', () => {
  test('requires the int8 model and its token table', () => {
    expect(REQUIRED_MODEL_FILES).toEqual(['model.int8.onnx', 'tokens.txt']);
  });
});
