import { describe, expect, test } from 'vitest';

import type { Model } from './modelSlice';
import modelReducer, {
  clearAgentSelectedModel,
  selectAgentSelectedModel,
  setAvailableModels,
  setDefaultSelectedModel,
  setSelectedModel,
} from './modelSlice';

const modelA: Model = { id: 'gpt-4o', name: 'GPT-4o', providerKey: 'openai' };
const modelB: Model = { id: 'glm-5.1', name: 'GLM 5.1', providerKey: 'zhipu' };
const modelC: Model = { id: 'claude-3-sonnet', name: 'Claude 3 Sonnet', providerKey: 'anthropic' };
const lockedModel: Model = { id: 'server-model', name: 'Server Model', providerKey: 'lobsterai-server', accessible: false };
const customKimiModel: Model = { id: 'kimi-k2.6', name: 'Kimi K2.6', providerKey: 'moonshot' };
const planKimiModel: Model = { id: 'kimi-k2.6', name: 'Kimi K2.6', providerKey: 'lobsterai-server' };

function makeState(overrides?: Partial<ReturnType<typeof modelReducer>>) {
  const base = modelReducer(undefined, { type: 'init' });
  return { ...base, ...overrides };
}

describe('setSelectedModel', () => {
  test('writes per-agent model to map', () => {
    const state = modelReducer(undefined, setSelectedModel({ agentId: 'agent-1', model: modelA }));
    expect(state.selectedModelByAgent['agent-1']).toEqual(modelA);
  });

  test('overwrites existing per-agent model', () => {
    let state = modelReducer(undefined, setSelectedModel({ agentId: 'agent-1', model: modelA }));
    state = modelReducer(state, setSelectedModel({ agentId: 'agent-1', model: modelB }));
    expect(state.selectedModelByAgent['agent-1']).toEqual(modelB);
  });

  test('independent per-agent entries', () => {
    let state = modelReducer(undefined, setSelectedModel({ agentId: 'agent-1', model: modelA }));
    state = modelReducer(state, setSelectedModel({ agentId: 'agent-2', model: modelB }));
    expect(state.selectedModelByAgent['agent-1']).toEqual(modelA);
    expect(state.selectedModelByAgent['agent-2']).toEqual(modelB);
  });
});

describe('setDefaultSelectedModel', () => {
  test('sets app-level default model', () => {
    const state = modelReducer(undefined, setDefaultSelectedModel(modelB));
    expect(state.defaultSelectedModel).toEqual(modelB);
  });
});

describe('clearAgentSelectedModel', () => {
  test('removes agent entry from map', () => {
    let state = modelReducer(undefined, setSelectedModel({ agentId: 'agent-1', model: modelA }));
    state = modelReducer(state, clearAgentSelectedModel('agent-1'));
    expect(state.selectedModelByAgent['agent-1']).toBeUndefined();
  });

  test('no-op for non-existent agent', () => {
    const state = modelReducer(undefined, clearAgentSelectedModel('non-existent'));
    expect(Object.keys(state.selectedModelByAgent)).toHaveLength(0);
  });
});

describe('setAvailableModels', () => {
  test('replaces available models with the payload', () => {
    const state = modelReducer(undefined, setAvailableModels([modelA, modelB]));
    expect(state.availableModels).toEqual([modelA, modelB]);
  });

  test('re-matches per-agent models when available models change', () => {
    // Set up: agent has modelA selected
    let state = modelReducer(undefined, setSelectedModel({ agentId: 'agent-1', model: modelA }));

    // Update available models — modelA still present but with updated name
    const updatedModelA: Model = { ...modelA, name: 'GPT-4o (Updated)' };
    state = modelReducer(state, setAvailableModels([updatedModelA, modelB]));

    expect(state.selectedModelByAgent['agent-1'].name).toBe('GPT-4o (Updated)');
  });

  test('removes per-agent model when it is no longer available', () => {
    let state = modelReducer(undefined, setSelectedModel({ agentId: 'agent-1', model: modelA }));

    // Update available models — modelA removed
    state = modelReducer(state, setAvailableModels([modelB, modelC]));

    expect(state.selectedModelByAgent['agent-1']).toBeUndefined();
  });

  test('re-matches defaultSelectedModel', () => {
    let state = modelReducer(undefined, setDefaultSelectedModel(modelA));
    const updatedModelA: Model = { ...modelA, supportsImage: true };
    state = modelReducer(state, setAvailableModels([updatedModelA, modelB]));

    expect(state.defaultSelectedModel.supportsImage).toBe(true);
  });
});

describe('selectAgentSelectedModel', () => {
  test('returns per-agent override when present', () => {
    const state = makeState({
      selectedModelByAgent: { 'agent-1': modelA },
      availableModels: [modelA, modelB],
      defaultSelectedModel: modelB,
    });

    const result = selectAgentSelectedModel(state, 'agent-1', '');
    expect(result).toEqual(modelA);
  });

  test('resolves from agent model ref when no override', () => {
    const state = makeState({
      selectedModelByAgent: {},
      availableModels: [modelA, modelB],
      defaultSelectedModel: modelB,
    });

    const result = selectAgentSelectedModel(state, 'agent-1', 'openai/gpt-4o');
    expect(result.id).toBe('gpt-4o');
  });

  test('uses explicit plan agent model ref over a same-id custom override', () => {
    const state = makeState({
      selectedModelByAgent: { 'agent-1': customKimiModel },
      availableModels: [planKimiModel, customKimiModel],
      defaultSelectedModel: customKimiModel,
    });

    const result = selectAgentSelectedModel(state, 'agent-1', 'lobsterai-server/kimi-k2.6');

    expect(result).toEqual(planKimiModel);
  });

  test('uses explicit custom agent model ref over a same-id plan override', () => {
    const state = makeState({
      selectedModelByAgent: { 'agent-1': planKimiModel },
      availableModels: [planKimiModel, customKimiModel],
      defaultSelectedModel: planKimiModel,
    });

    const result = selectAgentSelectedModel(state, 'agent-1', 'moonshot/kimi-k2.6');

    expect(result).toEqual(customKimiModel);
  });

  test('ignores explicit agent model refs that resolve to locked models', () => {
    const state = makeState({
      selectedModelByAgent: {},
      availableModels: [lockedModel, modelA],
      defaultSelectedModel: modelA,
    });

    const result = selectAgentSelectedModel(state, 'agent-1', 'lobsterai-server/server-model');

    expect(result).toEqual(modelA);
  });

  test('falls back to defaultSelectedModel when agent model is empty', () => {
    const state = makeState({
      selectedModelByAgent: {},
      availableModels: [modelA, modelB],
      defaultSelectedModel: modelB,
    });

    const result = selectAgentSelectedModel(state, 'agent-1', '');
    expect(result).toEqual(modelB);
  });

  test('falls back to defaultSelectedModel when agent model ref is invalid', () => {
    const state = makeState({
      selectedModelByAgent: {},
      availableModels: [modelA, modelB],
      defaultSelectedModel: modelB,
    });

    const result = selectAgentSelectedModel(state, 'agent-1', 'nonexistent/model');
    expect(result).toEqual(modelB);
  });
});
