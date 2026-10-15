/**
 * One-way user data directory rename.
 *
 * The app used to live under `<appData>/LobsterAI` and now lives under
 * `<appData>/HiAi`. Without this, an existing install would start up against an
 * empty profile: the SQLite database, OpenClaw state, skills state and every
 * other file stay behind in the old directory and the app looks freshly
 * installed.
 *
 * Design constraints, in order of importance:
 *
 * 1. **Never destroy user data.** The legacy directory is only ever removed
 *    after the new one is in place. Any failure leaves the old directory
 *    untouched and boots with a fresh profile rather than aborting startup.
 * 2. **Idempotent.** Running on every start is safe: the migration is skipped
 *    as soon as the new directory exists.
 * 3. **Skip regenerable content.** Browser caches and logs are large and can be
 *    recreated, so copying them would slow startup for nothing.
 */
import fs from 'fs';
import path from 'path';

/** Top-level entries that are cheap to recreate and therefore not worth copying. */
const EXCLUDED_TOP_LEVEL_NAMES = new Set([
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'blob_storage',
  'logs',
  'Crashpad',
  'network',
  'Local Storage',
  'Session Storage',
  'IndexedDB',
  'Service Worker',
  'WebStorage',
]);

export interface MigrateLegacyUserDataDirOptions {
  /** Parent directory that holds the per-app profile, i.e. `app.getPath('appData')`. */
  appDataPath: string;
  /** Directory name used before the rename, e.g. `LobsterAI`. */
  legacyDirName: string;
  /** Directory name used now, e.g. `HiAi`. */
  currentDirName: string;
}

export type MigrateLegacyUserDataDirOutcome =
  /** Nothing to do: the new profile already exists, or the names match. */
  | 'skipped-target-exists'
  | 'skipped-same-name'
  /** No legacy profile on disk, so this is a fresh install. */
  | 'skipped-no-legacy-dir'
  /** The legacy profile was moved into place. */
  | 'moved'
  /** The rename failed (usually a cross-device link); the copy succeeded. */
  | 'copied'
  /** Copying failed too. The legacy directory is left in place. */
  | 'failed';

const exists = (targetPath: string): boolean => {
  try {
    return fs.existsSync(targetPath);
  } catch {
    return false;
  }
};

const listDirSafely = (dirPath: string): fs.Dirent[] => {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
};

const copyDirRecursive = (source: string, destination: string): void => {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of listDirSafely(source)) {
    if (EXCLUDED_TOP_LEVEL_NAMES.has(entry.name)) continue;
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(from, to);
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to);
    }
  }
};

/**
 * Moves `<appData>/<legacyDirName>` to `<appData>/<currentDirName>` when the
 * target does not exist yet. Safe to call on every launch.
 */
export const migrateLegacyUserDataDir = (
  options: MigrateLegacyUserDataDirOptions,
): MigrateLegacyUserDataDirOutcome => {
  const { appDataPath, legacyDirName, currentDirName } = options;
  if (legacyDirName === currentDirName) return 'skipped-same-name';

  const legacyPath = path.join(appDataPath, legacyDirName);
  const currentPath = path.join(appDataPath, currentDirName);

  // The new profile wins whenever it already exists. This is what makes the
  // migration safe to repeat: a partially completed copy is never re-run over.
  if (exists(currentPath)) return 'skipped-target-exists';
  if (!exists(legacyPath)) return 'skipped-no-legacy-dir';

  try {
    // Same-volume rename is atomic and instant; only cross-device links fail.
    fs.renameSync(legacyPath, currentPath);
    return 'moved';
  } catch (renameError) {
    console.warn(
      `[UserDataMigration] rename of "${legacyPath}" failed, falling back to copy:`,
      renameError,
    );
  }

  try {
    copyDirRecursive(legacyPath, currentPath);
  } catch (copyError) {
    // Deliberately keeps the legacy directory: losing the profile silently is
    // far worse than starting empty, because the old files remain recoverable.
    console.error(
      `[UserDataMigration] failed to copy legacy profile from "${legacyPath}". `
      + 'Starting with an empty profile; the previous data is still in that directory.',
      copyError,
    );
    return 'failed';
  }

  try {
    fs.rmSync(legacyPath, { recursive: true, force: true });
  } catch (cleanupError) {
    // A leftover directory is harmless: the next launch sees the target exists
    // and skips, so this never escalates.
    console.warn(
      `[UserDataMigration] copied the profile but could not remove "${legacyPath}":`,
      cleanupError,
    );
  }
  return 'copied';
};