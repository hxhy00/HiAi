import { beforeEach, describe, expect, test, vi } from 'vitest';

const post = vi.fn();

vi.mock('axios', () => ({
  default: {
    post: (...args: unknown[]) => post(...args),
    isAxiosError: (value: unknown) => Boolean(
      value && typeof value === 'object' && (value as { isAxiosError?: boolean }).isAxiosError,
    ),
  },
}));

import { PromptPolishFailureReason } from '../../shared/cowork/constants';
import {
  type OneShotLlmConfig,
  polishPrompt,
  resolveOneShotLlmConfig,
} from './promptPolisher';

const openAiConfig: OneShotLlmConfig = {
  apiKey: 'sk-test',
  baseUrl: 'https://api.example.com/v1',
  model: 'gpt-4o',
  provider: 'deepseek',
};

const openAiResponsesConfig: OneShotLlmConfig = {
  apiKey: 'sk-test',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o',
  provider: 'openai',
};

const anthropicConfig: OneShotLlmConfig = {
  apiKey: 'sk-ant',
  baseUrl: 'https://api.anthropic.com',
  model: 'claude-3-5-sonnet-20241022',
  provider: 'anthropic',
};

beforeEach(() => {
  post.mockReset();
});

describe('resolveOneShotLlmConfig', () => {
  test('prefers the first enabled provider that has a key', () => {
    const config = resolveOneShotLlmConfig({
      providers: {
        disabled: { enabled: false, apiKey: 'sk-off', baseUrl: 'https://a', models: [{ id: 'x' }] },
        active: { enabled: true, apiKey: 'sk-on', baseUrl: 'https://b', models: [{ id: 'm1' }] },
      },
      api: { key: 'legacy', baseUrl: 'https://legacy' },
    });
    expect(config).toEqual({
      apiKey: 'sk-on',
      baseUrl: 'https://b',
      model: 'm1',
      provider: 'active',
    });
  });

  test('skips enabled providers without a key', () => {
    const config = resolveOneShotLlmConfig({
      providers: { keyless: { enabled: true, baseUrl: 'https://a' } },
      api: { key: 'legacy', baseUrl: 'https://legacy' },
      model: { defaultModel: 'legacy-model' },
    });
    expect(config).toEqual({
      apiKey: 'legacy',
      baseUrl: 'https://legacy',
      model: 'legacy-model',
    });
  });

  test('returns null when nothing is usable', () => {
    expect(resolveOneShotLlmConfig(null)).toBeNull();
    expect(resolveOneShotLlmConfig({})).toBeNull();
    expect(resolveOneShotLlmConfig({ providers: { p: { enabled: false } } })).toBeNull();
  });
});

describe('polishPrompt', () => {
  test('rejects an empty draft without calling the provider', async () => {
    const result = await polishPrompt({ draft: '   ', llmConfig: openAiConfig });
    expect(result).toEqual({ ok: false, reason: PromptPolishFailureReason.Empty });
    expect(post).not.toHaveBeenCalled();
  });

  test('reports no-model when no config is available', async () => {
    const result = await polishPrompt({ draft: 'hello', llmConfig: null });
    expect(result).toEqual({ ok: false, reason: PromptPolishFailureReason.NoModel });
    expect(post).not.toHaveBeenCalled();
  });

  test('rewrites via the OpenAI chat completions endpoint', async () => {
    post.mockResolvedValueOnce({
      data: { choices: [{ message: { content: '  Rewritten prompt  ' } }] },
    });

    const result = await polishPrompt({ draft: 'do the thing', llmConfig: openAiConfig });

    expect(result).toEqual({ ok: true, text: 'Rewritten prompt' });
    expect(post).toHaveBeenCalledTimes(1);
    const [url, body] = post.mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/chat/completions');
    expect((body as { model: string }).model).toBe('gpt-4o');
    expect((body as { messages: Array<{ role: string }> }).messages[0].role).toBe('system');
    expect((body as { messages: Array<{ content: string }> }).messages[1].content).toBe('do the thing');
  });

  test('uses the OpenAI Responses API for the openai provider', async () => {
    post.mockResolvedValueOnce({ data: { output_text: 'Done' } });

    const result = await polishPrompt({ draft: 'hi', llmConfig: openAiResponsesConfig });

    expect(result).toEqual({ ok: true, text: 'Done' });
    const [url, body] = post.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect((body as { instructions: string }).instructions).toContain('rewrite');
  });

  test('rewrites via the Anthropic messages endpoint', async () => {
    post.mockResolvedValueOnce({
      data: { content: [{ type: 'text', text: 'Polished' }] },
    });

    const result = await polishPrompt({ draft: 'rough draft', llmConfig: anthropicConfig });

    expect(result).toEqual({ ok: true, text: 'Polished' });
    const [url, body] = post.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect((body as { system: string }).system).toContain('rewrite');
  });

  test('folds provider errors into a failed result', async () => {
    post.mockRejectedValueOnce({
      isAxiosError: true,
      message: 'Request failed',
      response: { status: 429, data: { error: { message: 'rate limited' } } },
    });

    const result = await polishPrompt({ draft: 'hello', llmConfig: openAiConfig });

    expect(result).toEqual({
      ok: false,
      reason: PromptPolishFailureReason.Failed,
      message: 'HTTP 429: rate limited',
    });
  });

  test('treats an empty model reply as a failure', async () => {
    post.mockResolvedValueOnce({ data: { choices: [{ message: { content: '   ' } }] } });

    const result = await polishPrompt({ draft: 'hello', llmConfig: openAiConfig });

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: PromptPolishFailureReason.Failed });
  });
});
