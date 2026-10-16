/**
 * Skill marketplace sources.
 *
 * The built-in skill store used to be a single first-party endpoint. The store
 * now aggregates several upstream registries, so the UI can switch between
 * them and the backend can normalise each provider's response into the shared
 * `MarketplaceSkill` shape.
 */

export const SkillMarketplaceSource = {
  /** First-party store (legacy `skill-store` endpoint). */
  Official: 'official',
  /** ClawHub public registry (`https://clawhub.ai`). */
  ClawHub: 'clawhub',
  /** SkillHub registry (`https://skillhub.cn`). */
  SkillHub: 'skillhub',
  /** skills.sh registry. Has no public list API; browse via ClawHub. */
  SkillsSh: 'skills-sh',
} as const;
export type SkillMarketplaceSource =
  typeof SkillMarketplaceSource[keyof typeof SkillMarketplaceSource];

/** Selectable sources, in display order. */
export const SKILL_MARKETPLACE_SOURCE_ORDER: SkillMarketplaceSource[] = [
  SkillMarketplaceSource.Official,
  SkillMarketplaceSource.ClawHub,
  SkillMarketplaceSource.SkillHub,
  SkillMarketplaceSource.SkillsSh,
];

export const SKILL_MARKETPLACE_SOURCES: Record<
  SkillMarketplaceSource,
  {
    /** i18n key for the tab label. */
    labelKey: string;
    /** Whether the source can list skills without a search query. */
    supportsBrowse: boolean;
    /** Whether the source supports keyword search. */
    supportsSearch: boolean;
  }
> = {
  [SkillMarketplaceSource.Official]: {
    labelKey: 'marketSourceOfficial',
    supportsBrowse: true,
    supportsSearch: true,
  },
  [SkillMarketplaceSource.ClawHub]: {
    labelKey: 'marketSourceClawHub',
    supportsBrowse: true,
    supportsSearch: true,
  },
  [SkillMarketplaceSource.SkillHub]: {
    labelKey: 'marketSourceSkillHub',
    supportsBrowse: true,
    supportsSearch: true,
  },
  [SkillMarketplaceSource.SkillsSh]: {
    labelKey: 'marketSourceSkillsSh',
    // skills.sh has no public list/search API; it is browsable through ClawHub.
    supportsBrowse: false,
    supportsSearch: false,
  },
};

export const DefaultSkillMarketplaceSource = SkillMarketplaceSource.Official;

export function isSkillMarketplaceSource(value: unknown): value is SkillMarketplaceSource {
  return typeof value === 'string'
    && (SKILL_MARKETPLACE_SOURCE_ORDER as string[]).includes(value);
}
