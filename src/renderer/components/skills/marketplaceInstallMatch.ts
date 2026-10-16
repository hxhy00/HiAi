import type { SkillInstallOrigin } from '../../../shared/skills/marketplaceSources';
import type { MarketplaceSkill, Skill } from '../../types/skill';

/**
 * Resolve the installed skill that corresponds to a marketplace entry.
 *
 * Marketplace ids are namespaced by source (`clawhub:owner/slug`) and can never
 * equal an installed directory name, so the recorded origin is authoritative
 * once present. Skills installed before origins existed have no entry and fall
 * back to plain id matching, which keeps the official store working unchanged.
 */
export const findInstalledSkillIdFor = (
  marketplaceSkill: Pick<MarketplaceSkill, 'id'>,
  skills: Pick<Skill, 'id'>[],
  origins: Record<string, SkillInstallOrigin>,
): string | undefined => {
  const matched = Object.entries(origins)
    .find(([, origin]) => origin.sourceId === marketplaceSkill.id);
  if (matched) {
    const [skillId] = matched;
    return skills.some(skill => skill.id === skillId) ? skillId : undefined;
  }
  return skills.find(skill => skill.id === marketplaceSkill.id)?.id;
};

/**
 * Reverse lookup: the marketplace entry an installed skill came from. Falls
 * back to plain id matching so official-store skills keep their detail links.
 */
export const findMarketplaceSkillForInstalled = <T extends Pick<MarketplaceSkill, 'id'>>(
  installedSkillId: string,
  marketplaceSkills: T[],
  origins: Record<string, SkillInstallOrigin>,
): T | undefined => {
  const sourceId = origins[installedSkillId]?.sourceId;
  if (sourceId) {
    const matched = marketplaceSkills.find(entry => entry.id === sourceId);
    if (matched) return matched;
  }
  return marketplaceSkills.find(entry => entry.id === installedSkillId);
};

/**
 * Append a cursor page to the current list, dropping ids already shown so a
 * source that repeats entries across pages cannot produce duplicate cards.
 */
export const appendMarketplacePage = <T extends Pick<MarketplaceSkill, 'id'>>(
  current: T[],
  incoming: T[],
): T[] => {
  if (incoming.length === 0) {
    return current;
  }
  const seen = new Set(current.map(skill => skill.id));
  const additions = incoming.filter(skill => {
    if (seen.has(skill.id)) return false;
    seen.add(skill.id);
    return true;
  });
  return additions.length > 0 ? [...current, ...additions] : current;
};
