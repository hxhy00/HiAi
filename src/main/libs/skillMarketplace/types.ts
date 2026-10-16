import type { LocalizedText } from '../../../shared/kit/constants';
import type { SkillMarketplaceSource } from '../../../shared/skills/marketplaceSources';

/**
 * Normalised marketplace skill entry produced by every source adapter.
 * Mirrors the renderer's `MarketplaceSkill` type so the UI stays source-agnostic.
 */
export interface NormalizedMarketplaceSkill {
  /** Stable, source-scoped identifier (e.g. `skillhub:@ns/slug`). */
  id: string;
  /** Raw upstream slug/name. */
  name: string;
  /** Plain text, or a localized pair from sources that ship both languages. */
  description: string | LocalizedText;
  /** Download URL for the skill archive (.zip). */
  url: string;
  version: string;
  source: {
    from: string;
    url: string;
    author?: string;
  };
  displayName?: string | LocalizedText;
  icon?: string;
  downloadCount?: number;
  /** Which marketplace this entry came from. */
  marketplace: SkillMarketplaceSource;
}

export interface MarketplaceQuery {
  /** Free-text search; empty means "browse". */
  query?: string;
  limit?: number;
  /** Opaque pagination cursor returned by a previous call. */
  cursor?: string;
}

export interface MarketplacePage {
  skills: NormalizedMarketplaceSkill[];
  /** Cursor for the next page, if the source supports pagination. */
  nextCursor?: string;
}

/** Localized metadata for skills already installed on this machine. */
export interface LocalSkillMetadata {
  id: string;
  name: string;
  version: string;
  displayName?: string | LocalizedText;
  description?: string | LocalizedText;
}

/** Every source adapter implements this contract. */
export interface MarketplaceSourceAdapter {
  readonly source: SkillMarketplaceSource;
  fetchPage(query: MarketplaceQuery): Promise<MarketplacePage>;
}

export class MarketplaceError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'MarketplaceError';
  }
}
