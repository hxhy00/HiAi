/**
 * Skill marketplace sources.
 *
 * The marketplace shows one aggregated list instead of a source switcher. Two
 * upstreams feed it: the first-party Youdao store and the SkillHub registry.
 * ClawHub and skills.sh were dropped — skills.sh had no list API of its own and
 * was served through the ClawHub adapter, so keeping it only duplicated rows.
 */

export const SkillMarketplaceSource = {
  /** First-party store (`api-overmind.youdao.com`), surfaced as "youdao". */
  Youdao: 'youdao',
  /** SkillHub registry (`https://skillhub.cn`). */
  SkillHub: 'skillhub',
} as const;
export type SkillMarketplaceSource =
  typeof SkillMarketplaceSource[keyof typeof SkillMarketplaceSource];

/** Aggregated sources, in display order: first-party first, then third-party. */
export const SKILL_MARKETPLACE_SOURCE_ORDER: SkillMarketplaceSource[] = [
  SkillMarketplaceSource.Youdao,
  SkillMarketplaceSource.SkillHub,
];

export const SKILL_MARKETPLACE_SOURCES: Record<
  SkillMarketplaceSource,
  { labelKey: string; supportsBrowse: boolean; supportsSearch: boolean }
> = {
  [SkillMarketplaceSource.Youdao]: {
    labelKey: 'marketSourceYoudao',
    // The store returns one full page; the UI filters it locally.
    supportsBrowse: true,
    supportsSearch: false,
  },
  [SkillMarketplaceSource.SkillHub]: {
    labelKey: 'marketSourceSkillHub',
    supportsBrowse: true,
    supportsSearch: true,
  },
};

export const DefaultSkillMarketplaceSource = SkillMarketplaceSource.Youdao;

export function isSkillMarketplaceSource(value: unknown): value is SkillMarketplaceSource {
  return typeof value === 'string'
    && (SKILL_MARKETPLACE_SOURCE_ORDER as string[]).includes(value);
}

/**
 * Where an installed skill came from. Marketplace ids are namespaced
 * (`skillhub:@ns/slug`) and can never equal the installed directory name, so
 * the renderer needs this mapping to tell "installed" and "update available"
 * apart across sources. Skills installed before this existed simply have no
 * entry and fall back to plain id matching.
 */
export interface SkillInstallOrigin {
  marketplace: string;
  sourceId: string;
  url?: string;
  installedAt: number;
}

/** Caller-supplied origin; `installedAt` is stamped by the installer. */
export type SkillInstallOriginInput = Omit<SkillInstallOrigin, 'installedAt'>;
