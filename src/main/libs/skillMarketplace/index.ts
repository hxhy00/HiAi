import {
  DefaultSkillMarketplaceSource,
  isSkillMarketplaceSource,
  SKILL_MARKETPLACE_SOURCE_ORDER,
  SkillMarketplaceSource,
} from '../../../shared/skills/marketplaceSources';
import { skillhubAdapter } from './skillhubAdapter';
import type {
  LocalSkillMetadata,
  MarketplacePage,
  MarketplaceQuery,
  MarketplaceSourceAdapter,
  NormalizedMarketplaceSkill,
} from './types';
import { MarketplaceError } from './types';
import {
  fetchYoudaoLocalSkills,
  invalidateYoudaoStoreCache,
  youdaoAdapter,
} from './youdaoAdapter';

export type {
  LocalSkillMetadata,
  MarketplacePage,
  MarketplaceQuery,
  NormalizedMarketplaceSkill,
} from './types';
export { MarketplaceError } from './types';
export { invalidateYoudaoStoreCache };

const adapters: Partial<Record<SkillMarketplaceSource, MarketplaceSourceAdapter>> = {
  [SkillMarketplaceSource.Youdao]: youdaoAdapter,
  [SkillMarketplaceSource.SkillHub]: skillhubAdapter,
};

/** Per-source failure, so one dead upstream cannot blank the whole list. */
export interface UnifiedMarketplaceResult {
  skills: NormalizedMarketplaceSkill[];
  /** Sources that failed, mapped to their error message. */
  errors: Partial<Record<SkillMarketplaceSource, string>>;
  /** Cursors keyed by source, for sources that paginate. */
  nextCursors: Partial<Record<SkillMarketplaceSource, string>>;
  /** Localized metadata for skills already installed on this machine. */
  localSkills: LocalSkillMetadata[];
}

/** Fetch one page from a marketplace source. */
export async function fetchMarketplacePage(
  source: unknown,
  query: MarketplaceQuery = {},
): Promise<MarketplacePage> {
  const resolved = isSkillMarketplaceSource(source) ? source : DefaultSkillMarketplaceSource;
  const adapter = adapters[resolved];
  if (!adapter) {
    throw new MarketplaceError(`Marketplace source "${resolved}" has no list adapter`);
  }
  return adapter.fetchPage(query);
}

/** Whether this source is served by a local adapter. */
export function hasMarketplaceAdapter(source: unknown): boolean {
  return isSkillMarketplaceSource(source) && adapters[source] !== undefined;
}

/** Lower-cased slug used to spot the same skill arriving from two sources. */
function dedupeKey(skill: NormalizedMarketplaceSkill): string {
  return (skill.name || skill.id).trim().toLowerCase();
}

/**
 * Merge sources into one list: first-party entries first, then third-party
 * entries by popularity. Entries without a download count sink to the bottom of
 * their group instead of pretending to be the most popular.
 */
export function mergeMarketplaceSkills(
  pages: Array<{ source: SkillMarketplaceSource; skills: NormalizedMarketplaceSkill[] }>,
): NormalizedMarketplaceSkill[] {
  const merged: NormalizedMarketplaceSkill[] = [];
  const seen = new Set<string>();
  const order = new Map(SKILL_MARKETPLACE_SOURCE_ORDER.map((source, index) => [source, index]));

  const sorted = [...pages].sort(
    (a, b) => (order.get(a.source) ?? 99) - (order.get(b.source) ?? 99),
  );

  for (const { skills } of sorted) {
    const byPopularity = [...skills].sort((a, b) => {
      const left = a.downloadCount;
      const right = b.downloadCount;
      if (left === undefined && right === undefined) return 0;
      if (left === undefined) return 1;
      if (right === undefined) return -1;
      return right - left;
    });
    for (const skill of byPopularity) {
      const key = dedupeKey(skill);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(skill);
    }
  }
  return merged;
}

/**
 * Fetch every source in parallel and return one merged list. Failures are
 * reported per source instead of rejecting, so a single unreachable registry
 * leaves the rest of the marketplace usable.
 */
export async function fetchUnifiedMarketplace(
  query: MarketplaceQuery = {},
): Promise<UnifiedMarketplaceResult> {
  const term = (query.query ?? '').trim();
  const settled = await Promise.allSettled(
    SKILL_MARKETPLACE_SOURCE_ORDER.map(source => fetchMarketplacePage(source, { ...query, query: term })),
  );

  const errors: UnifiedMarketplaceResult['errors'] = {};
  const nextCursors: UnifiedMarketplaceResult['nextCursors'] = {};
  const pages: Array<{ source: SkillMarketplaceSource; skills: NormalizedMarketplaceSkill[] }> = [];

  settled.forEach((outcome, index) => {
    const source = SKILL_MARKETPLACE_SOURCE_ORDER[index];
    if (outcome.status === 'fulfilled') {
      pages.push({ source, skills: outcome.value.skills });
      if (outcome.value.nextCursor) nextCursors[source] = outcome.value.nextCursor;
      return;
    }
    const reason = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
    console.error(`[SkillMarketplace] source "${source}" failed:`, reason);
    errors[source] = reason;
  });

  let localSkills: LocalSkillMetadata[] = [];
  try {
    localSkills = await fetchYoudaoLocalSkills();
  } catch (error) {
    // Metadata only feeds localized names for installed skills; the list stands.
    console.error('[SkillMarketplace] failed to load local skill metadata:', error);
  }

  return { skills: mergeMarketplaceSkills(pages), errors, nextCursors, localSkills };
}
