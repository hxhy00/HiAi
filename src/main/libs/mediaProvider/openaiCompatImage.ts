/**
 * OpenAI-compatible image generation adapter.
 *
 * Handles the local (no HiAi server) image path:
 *   POST {baseUrl}/images/generations  — text-to-image
 *   POST {baseUrl}/images/edits        — image-to-image / reference images
 *
 * Synchronous by nature: the upstream call returns URLs (or base64) in the
 * same response, so the task is already terminal when `generate` resolves.
 */
import type { SqliteStore } from '../../sqliteStore';
import { IMAGE_PARAMETER_SPEC } from './parameterSpecs';
import { findMediaEntry, listMediaEntries } from './store';
import {
  type MediaGenerateInput,
  type MediaGenerateOutput,
  type MediaProvider,
  MediaProviderError,
  MediaProviderKind,
  type MediaProviderModel,
  type MediaProviderTarget,
  type MediaStatusOutput,
  MediaTaskStatus,
} from './types';

const IMAGE_GENERATIONS_PATH = '/images/generations';
const IMAGE_EDITS_PATH = '/images/edits';
const DEFAULT_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

/** Parameters accepted by the OpenAI images API, in upstream spelling. */
const OPENAI_IMAGE_PARAMS = [
  'n',
  'size',
  'quality',
  'style',
  'response_format',
  'output_format',
  'background',
  'moderation',
  'user',
] as const;

interface OpenAIImageResponse {
  created?: number;
  data?: Array<{
    url?: string;
    b64_json?: string;
    revised_prompt?: string;
  }>;
  error?: { message?: string; code?: string; type?: string };
}

const takeString = (value: unknown): string | undefined => (
  typeof value === 'string' && value.trim() ? value.trim() : undefined
);

const joinUrl = (baseUrl: string, path: string): string => {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (!trimmed) {
    throw new MediaProviderError(
      'MEDIA_PROVIDER_BASE_URL_MISSING',
      'Image provider baseUrl is not configured.',
    );
  }
  // Accept a baseUrl that already carries an API version segment, e.g. `/v1`.
  return `${trimmed}${path}`;
};

const collectImageParams = (params: Record<string, unknown>): Record<string, unknown> => {
  const result: Record<string, unknown> = {};
  for (const key of OPENAI_IMAGE_PARAMS) {
    if (params[key] !== undefined && params[key] !== null) {
      result[key] = params[key];
    }
  }
  return result;
};

/** Reference images are passed as data URLs or paths already resolved upstream. */
const collectReferenceImages = (params: Record<string, unknown>): string[] => {
  const direct = Array.isArray(params.images)
    ? (params.images as unknown[]).filter(
      (item): item is string => typeof item === 'string' && item.trim().length > 0,
    )
    : [];
  const single = takeString(params.image);
  const firstFrame = takeString(params.firstFrame);
  return [
    ...(single ? [single] : []),
    ...direct,
    ...(firstFrame ? [firstFrame] : []),
  ].filter((value, index, all) => all.indexOf(value) === index);
};

const toRequestBody = (
  modelId: string,
  prompt: string,
  params: Record<string, unknown>,
  referenceImages: string[],
): Record<string, unknown> => ({
  model: modelId,
  prompt,
  ...collectImageParams(params),
  ...(referenceImages.length > 0
    ? { image: referenceImages.length === 1 ? referenceImages[0] : referenceImages }
    : {}),
});

const parseImagesResponse = (payload: OpenAIImageResponse): string[] => {
  const items = Array.isArray(payload.data) ? payload.data : [];
  const urls: string[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const url = takeString(item.url);
    if (url) {
      urls.push(url);
      continue;
    }
    const base64 = takeString(item.b64_json);
    if (base64) {
      urls.push(`data:image/png;base64,${base64}`);
    }
  }
  return urls;
};

const buildSyntheticTaskId = (modelId: string): string => (
  `local-image-${modelId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
);

export interface OpenAIImageAdapterOptions {
  store: SqliteStore;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export const createOpenAIImageAdapter = (options: OpenAIImageAdapterOptions): MediaProvider => {
  const { store } = options;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  const listModels = (): MediaProviderModel[] => (
    listMediaEntries(store, MediaProviderKind.Image).map(entry => ({
      modelId: entry.modelId,
      displayName: entry.displayName,
      providerKey: entry.key,
      parameterSpec: IMAGE_PARAMETER_SPEC,
      ...(entry.capabilities ? { capabilities: entry.capabilities } : {}),
    }))
  );

  const resolveTarget = (modelId: string): MediaProviderTarget | undefined => {
    const entry = findMediaEntry(store, MediaProviderKind.Image, modelId);
    if (!entry) return undefined;
    return {
      providerKey: entry.key,
      baseUrl: entry.baseUrl,
      apiKey: entry.apiKey,
      modelId: entry.modelId,
      displayName: entry.displayName,
    };
  };

  const generate = async (input: MediaGenerateInput): Promise<MediaGenerateOutput> => {
    const { target, prompt, params } = input;
    const modelId = target.modelId || target.providerKey;
    const referenceImages = collectReferenceImages(params);
    const path = referenceImages.length > 0 ? IMAGE_EDITS_PATH : IMAGE_GENERATIONS_PATH;
    const url = joinUrl(target.baseUrl, path);

    if (!target.apiKey) {
      throw new MediaProviderError(
        'MEDIA_PROVIDER_API_KEY_MISSING',
        `Image provider "${target.providerKey}" has no API key configured.`,
      );
    }

    const body = toRequestBody(modelId, prompt, params, referenceImages);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${target.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new MediaProviderError(
        'MEDIA_PROVIDER_REQUEST_FAILED',
        `Image generation request to "${url}" failed: ${message}`,
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let payload: OpenAIImageResponse = {};
    if (text.trim()) {
      try {
        payload = JSON.parse(text) as OpenAIImageResponse;
      } catch {
        throw new MediaProviderError(
          'MEDIA_PROVIDER_INVALID_RESPONSE',
          `Image provider returned non-JSON (HTTP ${response.status}).`,
        );
      }
    }

    if (!response.ok) {
      const upstreamMessage = takeString(payload.error?.message) ?? `HTTP ${response.status}`;
      throw new MediaProviderError(
        `MEDIA_PROVIDER_HTTP_${response.status}`,
        `Image generation failed: ${upstreamMessage}`,
      );
    }

    const resultUrls = parseImagesResponse(payload);
    if (resultUrls.length === 0) {
      throw new MediaProviderError(
        'MEDIA_PROVIDER_EMPTY_RESULT',
        'Image provider returned no image data.',
      );
    }

    return {
      taskId: buildSyntheticTaskId(modelId),
      status: MediaTaskStatus.Succeeded,
      resultUrls,
      model: modelId,
      upstreamModel: modelId,
    };
  };

  const status = async (taskId: string): Promise<MediaStatusOutput> => {
    // Local image generation is synchronous; an unknown task id can only mean
    // the caller polled a task from a previous app session.
    throw new MediaProviderError(
      'MEDIA_PROVIDER_TASK_NOT_FOUND',
      `Local image task "${taskId}" is not tracked; local image generation completes inline.`,
    );
  };

  return {
    kind: MediaProviderKind.Image,
    resolver: {
      listModels,
      resolveTarget,
      canServe: (modelId: string) => resolveTarget(modelId) !== undefined,
    },
    generate,
    status,
  };
};
