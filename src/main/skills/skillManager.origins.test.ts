import { describe, expect, test, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getAppPath: () => process.cwd(), getPath: () => '/tmp' },
  BrowserWindow: { getAllWindows: () => [] },
  session: { defaultSession: { webRequest: { onBeforeSendHeaders: () => {} } } },
}));

import { SkillManager } from './skillManager';
import { __skillManagerTestUtils } from './skillManager';

const { normalizeSkillOriginMap } = __skillManagerTestUtils;

/** Minimal in-memory stand-in for the kv slice of SqliteStore. */
const createStore = (initial: Record<string, unknown> = {}) => {
  const data = new Map<string, unknown>(Object.entries(initial));
  return {
    get: (key: string) => data.get(key),
    set: (key: string, value: unknown) => { data.set(key, value); },
    remove: (key: string) => { data.delete(key); },
    data,
  };
};

type OriginWriter = {
  recordInstallOrigins: (skillIds: string[], origin?: { marketplace: string; sourceId: string; url?: string }) => void;
  clearSkillOrigin: (skillId: string) => void;
};

const createManager = (store: ReturnType<typeof createStore>) => {
  const manager = new SkillManager(() => store as never) as unknown as SkillManager & OriginWriter;
  return manager;
};

describe('normalizeSkillOriginMap', () => {
  test('drops entries without a usable sourceId', () => {
    expect(normalizeSkillOriginMap({
      good: { marketplace: 'clawhub', sourceId: 'clawhub:a/b', installedAt: 5 },
      missing: { marketplace: 'clawhub' },
      empty: { marketplace: 'clawhub', sourceId: '' },
      notAnObject: 'clawhub',
    })).toEqual({
      good: { marketplace: 'clawhub', sourceId: 'clawhub:a/b', installedAt: 5 },
    });
  });

  test('normalizes partial and missing fields', () => {
    expect(normalizeSkillOriginMap({
      partial: { sourceId: 'skillhub:a/b' },
      legacy: { marketplace: 'clawhub', sourceId: 'clawhub:a/b', installedAt: 'nope', url: '' },
    })).toEqual({
      partial: { marketplace: '', sourceId: 'skillhub:a/b', installedAt: 0 },
      legacy: { marketplace: 'clawhub', sourceId: 'clawhub:a/b', installedAt: 0 },
    });
  });

  test('returns an empty map for non-object payloads', () => {
    expect(normalizeSkillOriginMap(undefined)).toEqual({});
    expect(normalizeSkillOriginMap(null)).toEqual({});
    expect(normalizeSkillOriginMap([])).toEqual({});
    expect(normalizeSkillOriginMap('nope')).toEqual({});
  });
});

describe('skill install origins', () => {
  test('records an origin for every freshly installed id', () => {
    const store = createStore();
    const manager = createManager(store);
    manager.recordInstallOrigins(['video-tools', 'pdf-tools'], {
      marketplace: 'clawhub',
      sourceId: 'clawhub:acme/tools',
      url: 'https://clawhub.ai/api/v1/download?owner=acme&slug=tools',
    });

    const origins = manager.listSkillInstallOrigins();
    expect(Object.keys(origins).sort()).toEqual(['pdf-tools', 'video-tools']);
    expect(origins['video-tools'].sourceId).toBe('clawhub:acme/tools');
    expect(origins['video-tools'].url).toContain('clawhub.ai');
    expect(origins['video-tools'].installedAt).toBeGreaterThan(0);
  });

  test('keeps the previous record for skills outside this install', () => {
    const store = createStore();
    const manager = createManager(store);
    manager.recordInstallOrigins(['video-tools'], { marketplace: 'clawhub', sourceId: 'clawhub:acme/video' });
    manager.recordInstallOrigins(['audio-tools'], { marketplace: 'skillhub', sourceId: 'skillhub:acme/audio' });

    const origins = manager.listSkillInstallOrigins();
    expect(origins['video-tools'].sourceId).toBe('clawhub:acme/video');
    expect(origins['audio-tools'].sourceId).toBe('skillhub:acme/audio');
  });

  test('reinstalling the same item drops the stale directory record', () => {
    const store = createStore();
    const manager = createManager(store);
    manager.recordInstallOrigins(['video-tools'], { marketplace: 'clawhub', sourceId: 'clawhub:acme/video' });
    manager.recordInstallOrigins(['video-tools-1'], { marketplace: 'clawhub', sourceId: 'clawhub:acme/video' });

    const origins = manager.listSkillInstallOrigins();
    expect(origins['video-tools']).toBeUndefined();
    expect(origins['video-tools-1'].sourceId).toBe('clawhub:acme/video');
  });

  test('ignores incomplete or empty origins', () => {
    const store = createStore();
    const manager = createManager(store);
    manager.recordInstallOrigins(['a'], { marketplace: 'clawhub', sourceId: '' });
    manager.recordInstallOrigins(['b'], { marketplace: '', sourceId: 'clawhub:a/b' });
    manager.recordInstallOrigins([], { marketplace: 'clawhub', sourceId: 'clawhub:a/b' });
    manager.recordInstallOrigins(['c'], undefined);

    expect(manager.listSkillInstallOrigins()).toEqual({});
    expect(store.data.has('skills_install_origins')).toBe(false);
  });

  test('clears the origin when the skill is deleted', () => {
    const store = createStore();
    const manager = createManager(store);
    manager.recordInstallOrigins(['video-tools'], { marketplace: 'clawhub', sourceId: 'clawhub:acme/video' });
    manager.clearSkillOrigin('video-tools');

    expect(manager.listSkillInstallOrigins()).toEqual({});
  });

  test('clearing an unknown skill leaves the map untouched', () => {
    const store = createStore();
    const manager = createManager(store);
    manager.recordInstallOrigins(['video-tools'], { marketplace: 'clawhub', sourceId: 'clawhub:acme/video' });
    manager.clearSkillOrigin('not-installed');

    expect(Object.keys(manager.listSkillInstallOrigins())).toEqual(['video-tools']);
  });
});
