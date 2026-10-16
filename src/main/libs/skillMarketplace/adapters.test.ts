import { beforeEach, describe, expect, test, vi } from 'vitest';

const fetchMock = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  app: { isPackaged: true },
  session: { defaultSession: { fetch: fetchMock } },
}));

import {
  SkillMarketplaceSource,
} from '../../../shared/skills/marketplaceSources';
import {
  fetchMarketplacePage,
  fetchUnifiedMarketplace,
  hasMarketplaceAdapter,
  invalidateYoudaoStoreCache,
  mergeMarketplaceSkills,
} from './index';
import type { NormalizedMarketplaceSkill } from './types';

const SKILLHUB_ORIGIN = 'https://api.skillhub.cn';
const YOUDAO_ORIGIN = 'https://api-overmind.youdao.com';

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

function skillhubSearchItem(overrides: Record<string, unknown> = {}) {
  return {
    name: 'AI Video Generation',
    description: 'Create AI videos',
    description_zh: '创建 AI 视频',
    slug: 'video-generation',
    version: '1.2.0',
    downloads: 42,
    installs: 7,
    icon_url: 'https://cdn.example/icon.png',
    namespace: { canonicalName: '@acme/video-generation', handle: 'acme' },
    ...overrides,
  };
}

function youdaoStore(overrides: Record<string, unknown> = {}) {
  return {
    code: 0,
    data: {
      value: {
        marketplace: [
          {
            id: 'canvas-design',
            name: 'canvas-design',
            version: '2.0.0',
            url: 'https://lobsterai.youdao.com/skills/canvas-design.zip',
            displayName: { en: 'Canvas Design', zh: '画布设计' },
            description: { en: 'Design posters', zh: '设计海报' },
            source: { from: 'youdao', url: 'https://lobsterai.youdao.com', author: 'LobsterAI' },
          },
        ],
        localSkill: [
          { id: 'canvas-design', name: 'canvas-design', version: '2.0.0', displayName: { en: 'Canvas Design', zh: '画布设计' } },
        ],
        ...overrides,
      },
    },
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  invalidateYoudaoStoreCache();
});

describe('youdao adapter', () => {
  test('normalizes the store payload and keeps localized text', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(youdaoStore()));
    const page = await fetchMarketplacePage(SkillMarketplaceSource.Youdao);

    expect(page.skills).toHaveLength(1);
    const skill = page.skills[0];
    expect(skill.id).toBe('canvas-design');
    expect(skill.marketplace).toBe(SkillMarketplaceSource.Youdao);
    expect(skill.source.from).toBe('youdao');
    expect(skill.description).toEqual({ en: 'Design posters', zh: '设计海报' });
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url.startsWith(YOUDAO_ORIGIN)).toBe(true);
  });

  test('drops entries without a download url', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(youdaoStore({
      marketplace: [{ id: 'no-url', name: 'no-url' }],
    })));
    const page = await fetchMarketplacePage(SkillMarketplaceSource.Youdao);
    expect(page.skills).toEqual([]);
  });

  test('reuses one request for the list and the local-skill metadata', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(youdaoStore()));
    const result = await fetchUnifiedMarketplace();
    // Aggregated call: youdao + skillhub, plus metadata served from the cache.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.localSkills.map(entry => entry.id)).toEqual(['canvas-design']);
  });
});

describe('skillhub adapter', () => {
  test('searches with a query term and prefers installs for popularity', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ results: [skillhubSearchItem()] }));
    const page = await fetchMarketplacePage(SkillMarketplaceSource.SkillHub, { query: 'video', limit: 5 });

    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toContain(`${SKILLHUB_ORIGIN}/api/v1/search`);
    expect(String(url)).toContain('q=video');
    expect(String(url)).toContain('limit=5');
    const skill = page.skills[0];
    expect(skill.id).toBe('skillhub:@acme/video-generation');
    expect(skill.description).toBe('创建 AI 视频');
    expect(skill.downloadCount).toBe(7);
  });

  test('browses the showcase section without a query', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ section: 'hot_downloads', skills: [skillhubSearchItem()] }));
    await fetchMarketplacePage(SkillMarketplaceSource.SkillHub, {});
    expect(String(fetchMock.mock.calls[0][0])).toContain(`${SKILLHUB_ORIGIN}/api/v1/showcase/hot`);
  });
});

describe('mergeMarketplaceSkills', () => {
  const entry = (over: Partial<NormalizedMarketplaceSkill>): NormalizedMarketplaceSkill => ({
    id: 'id',
    name: 'name',
    description: '',
    url: 'https://example.test/s.zip',
    version: '1.0.0',
    source: { from: 'test', url: 'https://example.test' },
    marketplace: SkillMarketplaceSource.SkillHub,
    ...over,
  });

  test('puts the first-party source ahead of third-party entries', () => {
    const merged = mergeMarketplaceSkills([
      { source: SkillMarketplaceSource.SkillHub, skills: [entry({ id: 's1', name: 'third-party' })] },
      { source: SkillMarketplaceSource.Youdao, skills: [entry({ id: 'y1', name: 'official', marketplace: SkillMarketplaceSource.Youdao })] },
    ]);
    expect(merged.map(s => s.name)).toEqual(['official', 'third-party']);
  });

  test('orders each group by download count and sinks unknown counts', () => {
    const merged = mergeMarketplaceSkills([
      {
        source: SkillMarketplaceSource.SkillHub,
        skills: [
          entry({ id: 'a', name: 'unknown-count' }),
          entry({ id: 'b', name: 'low', downloadCount: 5 }),
          entry({ id: 'c', name: 'high', downloadCount: 900 }),
        ],
      },
    ]);
    expect(merged.map(s => s.name)).toEqual(['high', 'low', 'unknown-count']);
  });

  test('keeps one entry per slug across sources, first source wins', () => {
    const merged = mergeMarketplaceSkills([
      {
        source: SkillMarketplaceSource.Youdao,
        skills: [entry({ id: 'y', name: 'shared-slug', marketplace: SkillMarketplaceSource.Youdao })],
      },
      { source: SkillMarketplaceSource.SkillHub, skills: [entry({ id: 's', name: 'Shared-Slug' })] },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe('y');
  });
});

describe('fetchUnifiedMarketplace', () => {
  test('merges both sources and reports no errors when all succeed', async () => {
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.startsWith(YOUDAO_ORIGIN)) return jsonResponse(youdaoStore());
      return jsonResponse({ section: 'hot', skills: [skillhubSearchItem()] });
    });

    const result = await fetchUnifiedMarketplace();
    expect(result.errors).toEqual({});
    expect(result.skills.map(s => s.marketplace)).toEqual([
      SkillMarketplaceSource.Youdao,
      SkillMarketplaceSource.SkillHub,
    ]);
  });

  test('keeps the healthy source when one registry fails', async () => {
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.startsWith(YOUDAO_ORIGIN)) return jsonResponse(youdaoStore());
      return { ok: false, status: 503, json: async () => ({}) } as unknown as Response;
    });

    const result = await fetchUnifiedMarketplace();
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].marketplace).toBe(SkillMarketplaceSource.Youdao);
    expect(result.errors[SkillMarketplaceSource.SkillHub]).toMatch(/HTTP 503/);
  });

  test('sends the search term to every source', async () => {
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.startsWith(YOUDAO_ORIGIN)) return jsonResponse(youdaoStore());
      return jsonResponse({ results: [skillhubSearchItem()] });
    });

    await fetchUnifiedMarketplace({ query: 'video' });
    const skillhubCall = fetchMock.mock.calls.map(call => String(call[0])).find(url => url.includes('skillhub'));
    expect(skillhubCall).toContain('q=video');
  });

  test('survives a total outage with an empty list and recorded errors', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    const result = await fetchUnifiedMarketplace();
    expect(result.skills).toEqual([]);
    expect(Object.keys(result.errors)).toHaveLength(2);
  });
});

describe('dispatch', () => {
  test('unknown source falls back to the first-party store', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(youdaoStore()));
    const page = await fetchMarketplacePage('nope');
    expect(page.skills[0].marketplace).toBe(SkillMarketplaceSource.Youdao);
  });

  test('every declared source has an adapter', () => {
    expect(hasMarketplaceAdapter(SkillMarketplaceSource.Youdao)).toBe(true);
    expect(hasMarketplaceAdapter(SkillMarketplaceSource.SkillHub)).toBe(true);
    expect(hasMarketplaceAdapter('nope')).toBe(false);
  });
});
