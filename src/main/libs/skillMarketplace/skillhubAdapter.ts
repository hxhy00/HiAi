import { SkillMarketplaceSource } from '../../../shared/skills/marketplaceSources';
import { fetchJson, resolveAgainst } from './http';
import type {
  MarketplacePage,
  MarketplaceQuery,
  MarketplaceSourceAdapter,
  NormalizedMarketplaceSkill,
} from './types';

const SKILLHUB_ORIGIN = 'https://skillhub.cn';
const SKILLHUB_API_ORIGIN = 'https://api.skillhub.cn';
const SKILLHUB_SEARCH = `${SKILLHUB_API_ORIGIN}/api/v1/search`;
const SKILLHUB_SHOWCASE = `${SKILLHUB_API_ORIGIN}/api/v1/showcase`;
/** Download resolves through a redirect to the real archive. */
const SKILLHUB_DOWNLOAD = `${SKILLHUB_API_ORIGIN}/api/v1/download`;

/** Showcase section used when browsing without a search term. */
const DEFAULT_SECTION = 'hot';

interface SkillHubNamespace {
  canonicalName?: string;
  handle?: string;
  publicSlug?: string;
}

interface SkillHubItem {
  name?: string;
  displayName?: string;
  description?: string;
  description_zh?: string;
  slug?: string;
  version?: string;
  downloads?: number;
  installs?: number;
  owner_name?: string;
  icon_url?: string;
  homepage?: string;
  category?: string;
  namespace?: SkillHubNamespace;
}

interface SkillHubSearchResponse {
  results?: SkillHubItem[];
}

interface SkillHubShowcaseResponse {
  section?: string;
  skills?: SkillHubItem[];
}

export const skillhubAdapter: MarketplaceSourceAdapter = {
  source: SkillMarketplaceSource.SkillHub,

  async fetchPage(query: MarketplaceQuery): Promise<MarketplacePage> {
    const term = (query.query ?? '').trim();
    const limit = query.limit ?? 30;

    if (term) {
      const params = new URLSearchParams({ q: term, limit: String(limit) });
      const body = await fetchJson<SkillHubSearchResponse>(`${SKILLHUB_SEARCH}?${params.toString()}`);
      return { skills: normalizeAll(body.results) };
    }

    const params = new URLSearchParams({ limit: String(limit) });
    const body = await fetchJson<SkillHubShowcaseResponse>(
      `${SKILLHUB_SHOWCASE}/${DEFAULT_SECTION}?${params.toString()}`,
    );
    return { skills: normalizeAll(body.skills) };
  },
};

function normalizeAll(items: SkillHubItem[] | undefined): NormalizedMarketplaceSkill[] {
  return (items ?? [])
    .map(toNormalized)
    .filter((s): s is NormalizedMarketplaceSkill => s !== null);
}

function toNormalized(item: SkillHubItem): NormalizedMarketplaceSkill | null {
  const slug = (item.slug ?? '').trim();
  const canonical = (item.namespace?.canonicalName ?? '').trim();
  const handle = (item.namespace?.handle ?? item.owner_name ?? '').trim();
  const id = canonical || slug;
  if (!id) return null;

  const version = (item.version ?? '').trim();
  const description = (item.description_zh ?? item.description ?? '').trim();

  return {
    id: `skillhub:${id}`,
    name: (item.name ?? slug).trim() || slug,
    displayName: (item.displayName ?? '').trim() || undefined,
    description,
    // Download endpoint 302s to the archive; the installer follows redirects.
    url: `${SKILLHUB_DOWNLOAD}?slug=${encodeURIComponent(slug || id)}`,
    version,
    source: {
      from: 'SkillHub',
      url: (item.homepage ?? '').trim()
        || `${SKILLHUB_ORIGIN}/skills/${encodeURIComponent(slug || id)}`,
      author: handle || undefined,
    },
    icon: resolveAgainst(SKILLHUB_API_ORIGIN, item.icon_url),
    // `installs` is the engagement count; fall back to raw downloads when absent.
    downloadCount: typeof item.installs === 'number'
      ? item.installs
      : typeof item.downloads === 'number' ? item.downloads : undefined,
    marketplace: SkillMarketplaceSource.SkillHub,
  };
}
