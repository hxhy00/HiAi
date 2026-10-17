import { describe, expect, test } from 'vitest';

import type { InstalledKitRecord } from '../../shared/kit/constants';
import { SkinWorkflowKind } from '../../shared/skin/constants';
import { SkinPackKitId } from '../../shared/skin/kit';
import { SkinWorkflowRegistry } from './skinWorkflowRegistry';

const installedSkinKit: InstalledKitRecord = {
  id: SkinPackKitId.BuiltIn,
  version: '0.1.0',
  installedAt: 1,
  workflowKind: SkinWorkflowKind.SkinPack,
  skills: null,
  mcpServers: [],
  connectors: [],
};

const createRegistry = (parents: Record<string, string | null> = {}) => (
  new SkinWorkflowRegistry({
    getInstalledKits: () => ({
      [SkinPackKitId.BuiltIn]: installedSkinKit,
    }),
    getParentSessionId: sessionId => parents[sessionId] ?? null,
  })
);

describe('skin workflow registry', () => {
  test('activates only the selected trusted built-in skin Kit', () => {
    const registry = createRegistry();

    expect(registry.prepareTurn({
      sessionId: 'untrusted',
      kitIds: ['another-kit'],
    })).toEqual({});

    expect(registry.prepareTurn({
      sessionId: 'trusted',
      kitIds: [SkinPackKitId.BuiltIn],
    })).toEqual({
      workflowKind: SkinWorkflowKind.SkinPack,
    });
  });

  test('preserves workflow state across runtime completion and resolves child sessions', () => {
    const registry = createRegistry({ child: 'parent' });
    registry.prepareTurn({
      sessionId: 'parent',
      kitIds: [SkinPackKitId.BuiltIn],
    });
    registry.recordDraft('child', 'skin-one');

    registry.handleRuntimeComplete('parent');

    expect(registry.resolve('child')).toMatchObject({
      ownerSessionId: 'parent',
      state: {
        draftSkinId: 'skin-one',
      },
    });

    registry.finishWorkflow('child');
    expect(registry.resolve('parent')).toBeUndefined();
  });

  test('preserves an active draft when a later turn omits the Kit', () => {
    const registry = createRegistry();
    const input = {
      sessionId: 'continued-kit-session',
      kitIds: [SkinPackKitId.BuiltIn],
    };

    registry.prepareTurn(input);
    registry.recordDraft(input.sessionId, 'skin-one');
    registry.prepareTurn({
      sessionId: input.sessionId,
    });

    expect(registry.resolve(input.sessionId)?.state.draftSkinId).toBe('skin-one');
  });

  test('preserves a trusted workflow when a follow-up turn omits the Kit', () => {
    const registry = createRegistry();
    registry.prepareTurn({
      sessionId: 'clarification-session',
      kitIds: [SkinPackKitId.BuiltIn],
    });

    expect(registry.prepareTurn({
      sessionId: 'clarification-session',
    })).toEqual({
      workflowKind: SkinWorkflowKind.SkinPack,
    });
    expect(registry.resolve('clarification-session')?.state.workflowKind)
      .toBe(SkinWorkflowKind.SkinPack);

    registry.finishWorkflow('clarification-session');
    expect(registry.prepareTurn({
      sessionId: 'clarification-session',
    })).toEqual({});
  });

  test('clears exact session state on error or deletion', () => {
    const registry = createRegistry();
    const prepare = (sessionId: string) => registry.prepareTurn({
      sessionId,
      kitIds: [SkinPackKitId.BuiltIn],
    });

    prepare('error-session');
    registry.handleRuntimeError('error-session');
    expect(registry.resolve('error-session')).toBeUndefined();

    prepare('deleted-session');
    registry.handleSessionDeleted('deleted-session');
    expect(registry.resolve('deleted-session')).toBeUndefined();
  });
});
