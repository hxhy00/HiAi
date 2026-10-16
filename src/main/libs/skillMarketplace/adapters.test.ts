import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
}));

vi.mock('electron', () => ({
  session: {
    defaultSession: {
      fetch: mocks.fetch,
    },
  },
}));

import {
  DefaultSkillMarketplaceSource,
  SkillMarketplaceSource,
} from '../../../shared/skills/marketplaceSources';
import { fetchMarketplacePage, hasMarketplaceAdapter } from './index';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ClawHub adapter', () => {
  test('normalizes items into MarketplaceSkill shape and builds a download url', async () => {
    mocks.fetch.mockResolvedValue(jsonResponse({
      items: [
        {
          ownerHandle: 'dlazyai',
          slug: 'main-image-video',
          displayName: '主图视频',
          summary: 'turn a product image into a short video',
          stats: { downloads: 1232 },
          latestVersion: { version: '1.0.18' },
        },
      ],
      nextCursor: 'CURSOR-1',
    }));

    const page = await fetchMarketplacePage(SkillMarketplaceSource.ClawHub, { query: 'video', limit: 5 });

    const requestedUrl = new URL(mocks.fetch.mock.calls[0][0] as string);
    expect(requestedUrl.host).toBe('clawhub.ai');
    expect(requestedUrl.pathname).toBe('/api/v1/skills');
    expect(requestedUrl.searchParams.get('q')).toBe('video');
    expect(requestedUrl.searchParams.get('limit')).toBe('5');

    expect(page.nextCursor).toBe('CURSOR-1');
    expect(page.skills).toHaveLength(1);
    expect(page.skills[0]).toMatchObject({
      id: 'clawhub:dlazyai/main-image-video',
      name: 'main-image-video',
      displayName: '主图视频',
      description: 'turn a product image into a short video',
      version: '1.0.18',
      downloadCount: 1232,
      marketplace: SkillMarketplaceSource.ClawHub,
      source: { from: 'ClawHub', author: 'dlazyai' },
    });
    expect(page.skills[0].url).toBe(
      'https://clawhub.ai/api/v1/download?owner=dlazyai&slug=main-image-video',
    );
  });

  test('drops items without an owner or slug', async () => {
    mocks.fetch.mockResolvedValue(jsonResponse({
      items: [
        { ownerHandle: 'owner', slug: 'ok', summary: 's' },
        { ownerHandle: '', slug: 'no-owner' },
        { ownerHandle: 'no-slug', slug: '' },
      ],
    }));

    const page = await fetchMarketplacePage(SkillMarketplaceSource.ClawHub);
    expect(page.skills.map(s => s.id)).toEqual(['clawhub:owner/ok']);
  });
});

describe('SkillHub adapter', () => {
  test('searches and normalizes results (zh description preferred)', async () => {
    mocks.fetch.mockResolvedValue(jsonResponse({
      results: [
        {
          name: 'Pdf',
          displayName: 'Pdf',
          slug: 'document-pdf',
          version: '1.0.0',
          downloads: 34354,
          description: 'Comprehensive PDF toolkit',
          description_zh: '全面的PDF处理工具包',
          owner_name: 'kidaiangel',
          icon_url: 'https://cdn.example/icon.png',
          homepage: 'https://api.skillhub.cn/clawhub_kidaiangel/document-pdf',
          namespace: { canonicalName: '@clawhub_kidaiangel/document-pdf', handle: 'clawhub_kidaiangel' },
        },
      ],
    }));

    const page = await fetchMarketplacePage(SkillMarketplaceSource.SkillHub, { query: 'pdf' });

    const requestedUrl = new URL(mocks.fetch.mock.calls[0][0] as string);
    expect(requestedUrl.host).toBe('api.skillhub.cn');
    expect(requestedUrl.pathname).toBe('/api/v1/search');
    expect(requestedUrl.searchParams.get('q')).toBe('pdf');

    expect(page.skills).toHaveLength(1);
    expect(page.skills[0]).toMatchObject({
      id: 'skillhub:@clawhub_kidaiangel/document-pdf',
      displayName: 'Pdf',
      description: '全面的PDF处理工具包',
      version: '1.0.0',
      downloadCount: 34354,
      icon: 'https://cdn.example/icon.png',
      marketplace: SkillMarketplaceSource.SkillHub,
      source: { from: 'SkillHub', author: 'clawhub_kidaiangel' },
    });
    expect(page.skills[0].url).toBe(
      'https://api.skillhub.cn/api/v1/download?slug=document-pdf',
    );
  });

  test('browses the showcase section when no query is given', async () => {
    mocks.fetch.mockResolvedValue(jsonResponse({
      section: 'hot',
      skills: [{ name: 'Hot', slug: 'hot-skill', namespace: { canonicalName: '@x/hot-skill' } }],
    }));

    const page = await fetchMarketplacePage(SkillMarketplaceSource.SkillHub, {});

    const requestedUrl = new URL(mocks.fetch.mock.calls[0][0] as string);
    expect(requestedUrl.pathname).toBe('/api/v1/showcase/hot');
    expect(page.skills).toHaveLength(1);
    expect(page.skills[0].id).toBe('skillhub:@x/hot-skill');
  });
});

describe('skills.sh', () => {
  test('delegates browsing to the ClawHub adapter', async () => {
    mocks.fetch.mockResolvedValue(jsonResponse({ items: [{ ownerHandle: 'a', slug: 'b' }] }));

    const page = await fetchMarketplacePage(SkillMarketplaceSource.SkillsSh, {});

    const requestedUrl = new URL(mocks.fetch.mock.calls[0][0] as string);
    expect(requestedUrl.host).toBe('clawhub.ai');
    expect(page.skills[0].marketplace).toBe(SkillMarketplaceSource.ClawHub);
  });
});

describe('dispatch', () => {
  test('unknown source falls back to the default (official) which has no adapter', async () => {
    expect(hasMarketplaceAdapter('nope')).toBe(false);
    expect(hasMarketplaceAdapter(DefaultSkillMarketplaceSource)).toBe(false);
    expect(hasMarketplaceAdapter(SkillMarketplaceSource.ClawHub)).toBe(true);
    await expect(fetchMarketplacePage('nope')).rejects.toThrow(/no list adapter/);
  });

  test('surfaces non-2xx responses as errors', async () => {
    mocks.fetch.mockResolvedValue(jsonResponse({}, false, 500));
    await expect(fetchMarketplacePage(SkillMarketplaceSource.ClawHub)).rejects.toThrow(/HTTP 500/);
  });
});
