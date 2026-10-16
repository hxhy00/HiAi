import { SkillMarketplaceSource } from '../../../shared/skills/marketplaceSources';
import { getSkillStoreUrl } from '../endpoints';
import { fetchJson } from './http';
import type {
  LocalSkillMetadata,
  MarketplacePage,
  MarketplaceQuery,
  MarketplaceSourceAdapter,
  NormalizedMarketplaceSkill,
} from './types';

/**
 * First-party Youdao store.
 *
 * The legacy channel used a bare `https.get` with no User-Agent and returned the
 * raw body for the renderer to parse, which tied the UI to the server's response
 * shape. This adapter goes through the shared HTTP layer and caches the parsed
 * payload, because the installed-skill metadata comes from the same response.
 */

interface StoreItem {
  id?: string;
  name?: string;
  version?: string;
  displayName?: unknown;
  description?: unknown;
  url?: string;
  source?: { from?: string; url?: string; author?: string };
}

interface StoreResponse {
  code?: number;
  data?: { value?: { marketplace?: StoreItem[]; localSkill?: StoreItem[] } };
}

interface StorePayload {
  marketplace: NormalizedMarketplaceSkill[];
  localSkills: LocalSkillMetadata[];
}

/** Shared cache so the list and the installed-skill metadata cost one request. */
let cachedPayload: StorePayload | null = null;
let inFlight: Promise<StorePayload> | null = null;

function asLocalized(value: unknown): { en: string; zh: string } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as { en?: unknown; zh?: unknown };
  if (typeof candidate.en !== 'string' && typeof candidate.zh !== 'string') return undefined;
  return { en: typeof candidate.en === 'string' ? candidate.en : '', zh: typeof candidate.zh === 'string' ? candidate.zh : '' };
}

function toNormalized(item: StoreItem): NormalizedMarketplaceSkill | null {
  const id = (item.id ?? '').trim();
  const name = (item.name ?? id).trim();
  const url = (item.url ?? '').trim();
  // The installer needs a download URL; entries without one cannot be installed.
  if (!id || !name || !url) return null;
  return {
    id,
    name,
    description: asLocalized(item.description) ?? '',
    displayName: asLocalized(item.displayName) ?? undefined,
    url,
    version: (item.version ?? '').trim(),
    source: {
      from: item.source?.from?.trim() || 'youdao',
      url: item.source?.url?.trim() || getSkillStoreUrl(),
      author: item.source?.author?.trim() || undefined,
    },
    marketplace: SkillMarketplaceSource.Youdao,
  };
}

function toLocalMetadata(item: StoreItem): LocalSkillMetadata | null {
  const id = (item.id ?? '').trim();
  const name = (item.name ?? id).trim();
  if (!id && !name) return null;
  return {
    id,
    name,
    version: (item.version ?? '').trim(),
    displayName: asLocalized(item.displayName) ?? undefined,
    description: asLocalized(item.description) ?? undefined,
  };
}

async function loadStorePayload(): Promise<StorePayload> {
  if (cachedPayload) return cachedPayload;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const body = await fetchJson<StoreResponse>(getSkillStoreUrl(), {
      headers: { 'User-Agent': 'HiAi-SkillMarketplace' },
    });
    const value = body?.data?.value ?? {};
    const payload: StorePayload = {
      marketplace: (value.marketplace ?? [])
        .map(toNormalized)
        .filter((entry): entry is NormalizedMarketplaceSkill => entry !== null),
      localSkills: (value.localSkill ?? [])
        .map(toLocalMetadata)
        .filter((entry): entry is LocalSkillMetadata => entry !== null),
    };
    cachedPayload = payload;
    return payload;
  })();
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

/** Drop the cached store payload; the next call refetches. */
export function invalidateYoudaoStoreCache(): void {
  cachedPayload = null;
}

export async function fetchYoudaoLocalSkills(): Promise<LocalSkillMetadata[]> {
  const payload = await loadStorePayload();
  return payload.localSkills;
}

export const youdaoAdapter: MarketplaceSourceAdapter = {
  source: SkillMarketplaceSource.Youdao,

  async fetchPage(query: MarketplaceQuery): Promise<MarketplacePage> {
    const payload = await loadStorePayload();
    // The store has no query parameter; the UI filters locally, so honouring a
    // term here would only shrink the page the renderer already filters.
    void query;
    return { skills: payload.marketplace };
  },
};
