/**
 * One-shot prompt polishing.
 *
 * Rewrites a user's rough prompt into a clearer, structured one without
 * touching a Cowork session: no message records, no tool calls, no stream.
 * The result is returned to the renderer, which decides whether to apply it.
 *
 * Model resolution mirrors the IM chat path (first enabled provider with
 * credentials, else the legacy `api`/`model` config). Both share
 * `resolveOneShotLlmConfig` so the two never drift.
 */
import axios from 'axios';

import {
  PromptPolishFailureReason,
  type PromptPolishResult,
} from '../../shared/cowork/constants';

/** Minimal provider shape needed for a one-shot call. */
export interface OneShotLlmConfig {
  apiKey: string;
  baseUrl: string;
  model?: string;
  provider?: string;
}

/** The subset of app config the resolver reads. */
export interface OneShotLlmAppConfig {
  providers?: Record<string, {
    enabled?: boolean;
    apiKey?: string;
    baseUrl?: string;
    models?: Array<{ id: string }>;
  }>;
  api?: { key?: string; baseUrl?: string };
  model?: { defaultModel?: string };
}

/**
 * Pick the provider a one-shot call should use.
 *
 * Preference order: first enabled provider that carries an api key, then the
 * legacy flat `api` config. Returns null when nothing is usable, which callers
 * surface as "no model configured" rather than a generic failure.
 */
export function resolveOneShotLlmConfig(
  appConfig: OneShotLlmAppConfig | null | undefined,
): OneShotLlmConfig | null {
  if (!appConfig) return null;

  const providers = appConfig.providers ?? {};
  for (const [providerName, providerConfig] of Object.entries(providers)) {
    if (providerConfig?.enabled && providerConfig.apiKey) {
      return {
        apiKey: providerConfig.apiKey,
        baseUrl: providerConfig.baseUrl ?? '',
        model: providerConfig.models?.[0]?.id,
        provider: providerName,
      };
    }
  }

  if (appConfig.api?.key) {
    return {
      apiKey: appConfig.api.key,
      baseUrl: appConfig.api.baseUrl ?? '',
      model: appConfig.model?.defaultModel,
    };
  }

  return null;
}

/** Instruction sent as the system prompt. Kept deliberately narrow. */
export const PROMPT_POLISH_SYSTEM_PROMPT = [
  'You rewrite a user\'s draft prompt into a clearer, more effective prompt for an AI agent.',
  'Rules:',
  '- Preserve the user\'s original intent and any concrete details (names, paths, constraints).',
  '- Make the goal explicit, add structure when it helps, and remove ambiguity.',
  '- Do not add requirements the user did not imply.',
  '- Reply with the rewritten prompt only: no preamble, no explanations, no markdown fences.',
  '- Reply in the same language as the user\'s draft.',
].join('\n');

/** Request timeout. Polishing is a short, single-shot rewrite. */
const POLISH_TIMEOUT_MS = 30_000;
/** Output cap; a rewritten prompt is far shorter than this. */
const POLISH_MAX_TOKENS = 2048;

const stripBaseUrl = (baseUrl: string): string => baseUrl.trim().replace(/\/+$/, '');

const isAnthropicProvider = (config: OneShotLlmConfig): boolean => {
  const provider = config.provider?.toLowerCase();
  if (provider === 'anthropic') return true;
  if (config.baseUrl.toLowerCase().includes('anthropic')) return true;
  return config.model?.toLowerCase().startsWith('claude') ?? false;
};

const shouldUseOpenAIResponses = (config: OneShotLlmConfig): boolean =>
  config.provider?.toLowerCase() === 'openai';

const shouldUseMaxCompletionTokens = (config: OneShotLlmConfig): boolean => {
  const provider = config.provider?.toLowerCase();
  if (provider !== 'openai') return false;
  const model = (config.model ?? '').toLowerCase();
  const resolved = model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model;
  return resolved.startsWith('o1') || resolved.startsWith('o3') || resolved.startsWith('o4');
};

function buildChatCompletionsUrl(baseUrl: string, provider?: string): string {
  const normalized = stripBaseUrl(baseUrl);
  if (!normalized) return '/v1/chat/completions';
  if (normalized.endsWith('/chat/completions')) return normalized;

  const isGeminiLike = provider === 'gemini'
    || normalized.includes('generativelanguage.googleapis.com');
  if (isGeminiLike) {
    if (normalized.endsWith('/v1beta/openai') || normalized.endsWith('/v1/openai')) {
      return `${normalized}/chat/completions`;
    }
    if (normalized.endsWith('/v1beta')) return `${normalized}/openai/chat/completions`;
    if (normalized.endsWith('/v1')) {
      return `${normalized.slice(0, -3)}v1beta/openai/chat/completions`;
    }
    return `${normalized}/v1beta/openai/chat/completions`;
  }

  if (normalized.endsWith('/v1')) return `${normalized}/chat/completions`;
  return `${normalized}/v1/chat/completions`;
}

function buildResponsesUrl(baseUrl: string): string {
  const normalized = stripBaseUrl(baseUrl);
  if (!normalized) return '/v1/responses';
  if (normalized.endsWith('/responses')) return normalized;
  if (normalized.endsWith('/v1')) return `${normalized}/responses`;
  return `${normalized}/v1/responses`;
}

function extractResponsesText(payload: unknown): string {
  const data = payload as {
    output_text?: unknown;
    output?: Array<{ content?: Array<{ text?: unknown }> }>;
  } | null;
  if (typeof data?.output_text === 'string' && data.output_text) return data.output_text;
  const output = Array.isArray(data?.output) ? data.output : [];
  const chunks: string[] = [];
  for (const item of output) {
    if (!Array.isArray(item?.content)) continue;
    for (const contentItem of item.content) {
      if (typeof contentItem?.text === 'string' && contentItem.text) chunks.push(contentItem.text);
    }
  }
  return chunks.join('');
}

/**
 * Rewrite `draft` into a structured prompt via a single non-streaming call.
 *
 * Never throws: transport and provider errors are folded into a `failed`
 * result so the renderer can keep the draft intact and show a hint. An empty
 * or whitespace-only draft short-circuits before any network call.
 */
export async function polishPrompt(options: {
  draft: string;
  llmConfig: OneShotLlmConfig | null;
}): Promise<PromptPolishResult> {
  const draft = options.draft.trim();
  if (!draft) {
    return { ok: false, reason: PromptPolishFailureReason.Empty };
  }

  const config = options.llmConfig;
  if (!config || !config.baseUrl) {
    return { ok: false, reason: PromptPolishFailureReason.NoModel };
  }

  try {
    const polished = isAnthropicProvider(config)
      ? await callAnthropic(config, draft)
      : await callOpenAICompatible(config, draft);
    const trimmed = polished.trim();
    if (!trimmed) {
      return {
        ok: false,
        reason: PromptPolishFailureReason.Failed,
        message: 'The model returned an empty result.',
      };
    }
    return { ok: true, text: trimmed };
  } catch (error) {
    const message = axios.isAxiosError(error)
      ? `HTTP ${error.response?.status ?? '?'}: ${extractAxiosMessage(error.response?.data) ?? error.message}`
      : error instanceof Error ? error.message : String(error);
    return { ok: false, reason: PromptPolishFailureReason.Failed, message };
  }
}

function extractAxiosMessage(data: unknown): string | undefined {
  if (typeof data === 'string') return data.slice(0, 300);
  if (data && typeof data === 'object') {
    const record = data as { error?: { message?: unknown } | string; message?: unknown };
    if (typeof record.message === 'string') return record.message;
    if (record.error && typeof record.error === 'object' && typeof record.error.message === 'string') {
      return record.error.message;
    }
    if (typeof record.error === 'string') return record.error;
  }
  return undefined;
}

async function callAnthropic(config: OneShotLlmConfig, draft: string): Promise<string> {
  const url = `${stripBaseUrl(config.baseUrl)}/v1/messages`;
  const response = await axios.post(
    url,
    {
      model: config.model || 'claude-3-5-sonnet-20241022',
      max_tokens: POLISH_MAX_TOKENS,
      system: PROMPT_POLISH_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: draft }],
    },
    {
      headers: {
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      timeout: POLISH_TIMEOUT_MS,
    },
  );
  const content = response.data?.content;
  if (Array.isArray(content)) {
    return content
      .filter((block: { type?: string }) => block?.type === 'text')
      .map((block: { text?: string }) => block.text ?? '')
      .join('\n');
  }
  return typeof content?.text === 'string' ? content.text : '';
}

async function callOpenAICompatible(config: OneShotLlmConfig, draft: string): Promise<string> {
  const useResponses = shouldUseOpenAIResponses(config);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

  if (useResponses) {
    const response = await axios.post(
      buildResponsesUrl(config.baseUrl),
      {
        model: config.model || 'gpt-4o',
        instructions: PROMPT_POLISH_SYSTEM_PROMPT,
        input: [{ role: 'user', content: [{ type: 'input_text', text: draft }] }],
        max_output_tokens: POLISH_MAX_TOKENS,
      },
      { headers, timeout: POLISH_TIMEOUT_MS },
    );
    return extractResponsesText(response.data);
  }

  const body: Record<string, unknown> = {
    model: config.model || 'gpt-4o',
    messages: [
      { role: 'system', content: PROMPT_POLISH_SYSTEM_PROMPT },
      { role: 'user', content: draft },
    ],
  };
  if (shouldUseMaxCompletionTokens(config)) {
    body.max_completion_tokens = POLISH_MAX_TOKENS;
  } else {
    body.max_tokens = POLISH_MAX_TOKENS;
  }

  const response = await axios.post(
    buildChatCompletionsUrl(config.baseUrl, config.provider),
    body,
    { headers, timeout: POLISH_TIMEOUT_MS },
  );
  const content = response.data?.choices?.[0]?.message?.content;
  return typeof content === 'string' ? content : '';
}
