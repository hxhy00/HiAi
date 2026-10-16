import {
  DefaultSkillMarketplaceSource,
  isSkillMarketplaceSource,
  SkillMarketplaceSource,
} from '../../../shared/skills/marketplaceSources';
import { clawhubAdapter } from './clawhubAdapter';
import { skillhubAdapter } from './skillhubAdapter';
import type { MarketplacePage, MarketplaceQuery, MarketplaceSourceAdapter } from './types';
import { MarketplaceError } from './types';

export type {
  MarketplacePage,
  MarketplaceQuery,
  NormalizedMarketplaceSkill,
} from './types';
export { MarketplaceError } from './types';

const adapters: Partial<Record<SkillMarketplaceSource, MarketplaceSourceAdapter>> = {
  [SkillMarketplaceSource.ClawHub]: clawhubAdapter,
  [SkillMarketplaceSource.SkillHub]: skillhubAdapter,
  // skills.sh has no public list/search API of its own; ClawHub aggregates its
  // catalogue, so browsing "skills.sh" reuses the ClawHub adapter.
  [SkillMarketplaceSource.SkillsSh]: clawhubAdapter,
};

/**
 * Fetch one page from a marketplace source. The official first-party store is
 * still served by its own legacy endpoint, so it has no adapter here and must
 * be requested through the existing `skills:fetchMarketplace` channel.
 */
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

/** Whether this source is handled by the local adapters (vs. the legacy store). */
export function hasMarketplaceAdapter(source: unknown): boolean {
  return isSkillMarketplaceSource(source) && adapters[source] !== undefined;
}
