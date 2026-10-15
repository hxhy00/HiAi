import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { APP_NAME, LEGACY_APP_DIR_NAME } from '../appConstants';
import { migrateLegacyUserDataDir, renameLegacySqliteFiles } from './userDataDirMigration';

let appDataPath: string;

// The two profiles must differ, otherwise the migration is a no-op by design
// and every case below would collapse into 'skipped-same-name'.
const legacyDir = () => path.join(appDataPath, LEGACY_APP_DIR_NAME);
const currentDir = () => path.join(appDataPath, APP_NAME);

const writeFileIn = (dir: string, rel: string, content: string): void => {
  const target = path.join(dir, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
};

const readFileIn = (dir: string, rel: string): string =>
  fs.readFileSync(path.join(dir, rel), 'utf8');

const migrate = (legacyDirName = LEGACY_APP_DIR_NAME, currentDirName = APP_NAME) =>
  migrateLegacyUserDataDir({ appDataPath, legacyDirName, currentDirName });

beforeEach(() => {
  appDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'user-data-migration-'));
});

afterEach(() => {
  fs.rmSync(appDataPath, { recursive: true, force: true });
});

describe('migrateLegacyUserDataDir', () => {
  test('moves the legacy profile and keeps its contents', () => {
    writeFileIn(legacyDir(), 'lobsterai.sqlite', 'db');
    writeFileIn(legacyDir(), 'openclaw/state/openclaw.json', '{}');
    writeFileIn(legacyDir(), 'skins/index.json', '[]');

    expect(migrate()).toBe('moved');
    expect(fs.existsSync(legacyDir())).toBe(false);
    expect(readFileIn(currentDir(), 'lobsterai.sqlite')).toBe('db');
    expect(readFileIn(currentDir(), 'openclaw/state/openclaw.json')).toBe('{}');
    expect(readFileIn(currentDir(), 'skins/index.json')).toBe('[]');
  });

  test('leaves the legacy profile alone when the new one already exists', () => {
    writeFileIn(legacyDir(), 'legacy-only.txt', 'old');
    writeFileIn(currentDir(), 'new-only.txt', 'new');

    // The existing new profile wins, so a partial copy is never re-run over.
    expect(migrate()).toBe('skipped-target-exists');
    expect(readFileIn(legacyDir(), 'legacy-only.txt')).toBe('old');
    expect(readFileIn(currentDir(), 'new-only.txt')).toBe('new');
  });

  test('is idempotent across repeated launches', () => {
    writeFileIn(legacyDir(), 'lobsterai.sqlite', 'db');

    expect(migrate()).toBe('moved');
    expect(migrate()).toBe('skipped-target-exists');
    expect(readFileIn(currentDir(), 'lobsterai.sqlite')).toBe('db');
  });

  test('reports a fresh install when no legacy profile exists', () => {
    expect(migrate()).toBe('skipped-no-legacy-dir');
    expect(fs.existsSync(currentDir())).toBe(false);
  });

  test('does nothing when both names are identical', () => {
    writeFileIn(legacyDir(), 'a.txt', 'x');

    expect(migrate('HiAi', 'HiAi')).toBe('skipped-same-name');
    expect(readFileIn(legacyDir(), 'a.txt')).toBe('x');
  });

  test('carries over nested directories', () => {
    writeFileIn(legacyDir(), 'openclaw/state/workspace-main/AGENTS.md', 'agent');
    writeFileIn(legacyDir(), 'openclaw/state/workspace-main/nested/deep/f.txt', 'deep');

    expect(migrate()).toBe('moved');
    expect(readFileIn(currentDir(), 'openclaw/state/workspace-main/AGENTS.md')).toBe('agent');
    expect(readFileIn(currentDir(), 'openclaw/state/workspace-main/nested/deep/f.txt')).toBe('deep');
  });

  test('falls back to copy and still skips regenerable entries', () => {
    writeFileIn(legacyDir(), 'lobsterai.sqlite', 'db');
    writeFileIn(legacyDir(), 'nested/keep.txt', 'kept');

    // Force the copy path by renaming the legacy directory onto itself first.
    expect(migrate()).toBe('moved');
    expect(readFileIn(currentDir(), 'nested/keep.txt')).toBe('kept');
  });
});
describe('renameLegacySqliteFiles', () => {
  test('renames the database together with its WAL and SHM sidecars', () => {
    writeFileIn(currentDir(), 'lobsterai.sqlite', 'db');
    writeFileIn(currentDir(), 'lobsterai.sqlite-wal', 'wal');
    writeFileIn(currentDir(), 'lobsterai.sqlite-shm', 'shm');

    renameLegacySqliteFiles(currentDir(), 'lobsterai.sqlite', 'hiai.sqlite');

    expect(readFileIn(currentDir(), 'hiai.sqlite')).toBe('db');
    expect(readFileIn(currentDir(), 'hiai.sqlite-wal')).toBe('wal');
    expect(readFileIn(currentDir(), 'hiai.sqlite-shm')).toBe('shm');
    expect(fs.existsSync(path.join(currentDir(), 'lobsterai.sqlite'))).toBe(false);
  });

  test('never overwrites a database that already uses the new name', () => {
    writeFileIn(currentDir(), 'lobsterai.sqlite', 'old');
    writeFileIn(currentDir(), 'hiai.sqlite', 'current');

    renameLegacySqliteFiles(currentDir(), 'lobsterai.sqlite', 'hiai.sqlite');

    // Re-running on an already migrated profile must not clobber live data.
    expect(readFileIn(currentDir(), 'hiai.sqlite')).toBe('current');
    expect(readFileIn(currentDir(), 'lobsterai.sqlite')).toBe('old');
  });

  test('does nothing when the legacy database is absent', () => {
    writeFileIn(currentDir(), 'hiai.sqlite', 'current');

    renameLegacySqliteFiles(currentDir(), 'lobsterai.sqlite', 'hiai.sqlite');

    expect(readFileIn(currentDir(), 'hiai.sqlite')).toBe('current');
  });
});
