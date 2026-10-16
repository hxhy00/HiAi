import { SkillMarketplaceSource } from '../../../shared/skills/marketplaceSources';
import { fetchJson } from './http';
import type {
  MarketplacePage,
  MarketplaceQuery,
  MarketplaceSourceAdapter,
  NormalizedMarketplaceSkill,
} from './types';

const CLAWHUB_ORIGIN = 'https://clawhub.ai';
const CLAWHUB_API = `${CLAWHUB_ORIGIN}/api/v1/skills`;
const CLAWHUB_DOWNLOAD = `${CLAWHUB_ORIGIN}/api/v1/download`;

interface ClawHubItem {
  ownerHandle?: string;
  slug?: string;
  displayName?: string;
  summary?: string;
  description?: string | null;
  stats?: { downloads?: number };
  latestVersion?: { version?: string };
  tags?: Record<string, string>;
}

interface ClawHubListResponse {
  items?: ClawHubItem[];
  nextCursor?: string;
}

export const clawhubAdapter: MarketplaceSourceAdapter = {
  source: SkillMarketplaceSource.ClawHub,

  async fetchPage(query: MarketplaceQuery): Promise<MarketplacePage> {
    const params = new URLSearchParams();
    const limit = query.limit ?? 30;
    params.set('limit', String(limit));
    const term = (query.query ?? '').trim();
    if (term) params.set('q', term);
    if (query.cursor) params.set('cursor', query.cursor);

    const body = await fetchJson<ClawHubListResponse>(`${CLAWHUB_API}?${params.toString()}`, {
      headers: { 'User-Agent': 'HiAi-SkillMarketplace' },
    });

    const skills = (body.items ?? []).map(toNormalized).filter((s): s is NormalizedMarketplaceSkill => s !== null);
    return { skills, nextCursor: body.nextCursor?.trim() || undefined };
  },
};

function toNormalized(item: ClawHubItem): NormalizedMarketplaceSkill | null {
  const owner = (item.ownerHandle ?? '').trim();
  const slug = (item.slug ?? '').trim();
  if (!owner || !slug) return null;

  const version = (item.latestVersion?.version ?? item.tags?.latest ?? '').trim();
  const downloadUrl = `${CLAWHUB_DOWNLOAD}?owner=${encodeURIComponent(owner)}&slug=${encodeURIComponent(slug)}`;

  return {
    id: `clawhub:${owner}/${slug}`,
    name: slug,
    displayName: (item.displayName ?? '').trim() || undefined,
    description: (item.summary ?? item.description ?? '').trim(),
    url: downloadUrl,
    version,
    source: {
      from: 'ClawHub',
      url: `${CLAWHUB_ORIGIN}/${owner}/${slug}`,
      author: owner,
    },
    downloadCount: typeof item.stats?.downloads === 'number' ? item.stats.downloads : undefined,
    marketplace: SkillMarketplaceSource.ClawHub,
  };
}
