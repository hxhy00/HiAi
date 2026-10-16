import { describe, expect, test } from 'vitest';

import type { SkillInstallOrigin } from '../../../shared/skills/marketplaceSources';
import type { MarketplaceSkill } from '../../types/skill';
import {
  appendMarketplacePage,
  findInstalledSkillIdFor,
  findMarketplaceSkillForInstalled,
} from './marketplaceInstallMatch';

const origin = (
  skillId: string,
  sourceId: string,
  marketplace = 'clawhub',
): Record<string, SkillInstallOrigin> => ({
  [skillId]: { marketplace, sourceId, installedAt: 1_700_000_000_000 },
});

const entry = (id: string): Pick<MarketplaceSkill, 'id'> => ({ id });

describe('findInstalledSkillIdFor', () => {
  test('matches a third-party entry through its recorded origin', () => {
    expect(findInstalledSkillIdFor(
      entry('clawhub:acme/video-tools'),
      [{ id: 'video-tools' }],
      origin('video-tools', 'clawhub:acme/video-tools'),
    )).toBe('video-tools');
  });

  test('falls back to plain id matching when no origin is recorded', () => {
    // Official-store entries have no origin and their id equals the folder name.
    expect(findInstalledSkillIdFor(
      entry('official-skill'),
      [{ id: 'official-skill' }],
      {},
    )).toBe('official-skill');
  });

  test('returns undefined when the origin points at a deleted skill', () => {
    expect(findInstalledSkillIdFor(
      entry('clawhub:acme/video-tools'),
      [],
      origin('video-tools', 'clawhub:acme/video-tools'),
    )).toBeUndefined();
  });

  test('does not let a different origin hijack id matching', () => {
    // Another marketplace item owns the origin; this entry is still unknown.
    expect(findInstalledSkillIdFor(
      entry('clawhub:acme/other'),
      [{ id: 'video-tools' }],
      origin('video-tools', 'clawhub:acme/video-tools'),
    )).toBeUndefined();
  });
});

describe('findMarketplaceSkillForInstalled', () => {
  test('resolves the source entry of an installed third-party skill', () => {
    const skills = [{ id: 'video-tools' }, { id: 'clawhub:acme/video-tools' }];
    expect(findMarketplaceSkillForInstalled(
      'video-tools',
      skills,
      origin('video-tools', 'clawhub:acme/video-tools'),
    )?.id).toBe('clawhub:acme/video-tools');
  });

  test('falls back to id matching for skills without an origin', () => {
    expect(findMarketplaceSkillForInstalled('official-skill', [entry('official-skill')], {})?.id)
      .toBe('official-skill');
  });

  test('returns undefined when neither origin nor id matches', () => {
    expect(findMarketplaceSkillForInstalled('video-tools', [entry('clawhub:acme/other')], {}))
      .toBeUndefined();
  });
});

describe('appendMarketplacePage', () => {
  test('appends a new page after the current entries', () => {
    const current = [entry('a'), entry('b')];
    expect(appendMarketplacePage(current, [entry('c')]).map(s => s.id)).toEqual(['a', 'b', 'c']);
  });

  test('drops ids already shown so pages cannot duplicate cards', () => {
    const current = [entry('a'), entry('b')];
    expect(appendMarketplacePage(current, [entry('b'), entry('c')]).map(s => s.id))
      .toEqual(['a', 'b', 'c']);
  });

  test('keeps the current list when the next page brings nothing new', () => {
    const current = [entry('a')];
    expect(appendMarketplacePage(current, [entry('a')])).toBe(current);
    expect(appendMarketplacePage(current, [])).toBe(current);
  });
});
