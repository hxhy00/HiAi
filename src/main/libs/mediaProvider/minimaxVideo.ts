/**
 * MiniMax video generation adapter.
 *
 * MiniMax is not OpenAI-compatible; it uses a three-step async protocol:
 *   1. POST {baseUrl}/video_generation                  -> task_id
 *   2. GET  {baseUrl}/query/video_generation?task_id=   -> status / file_id
 *   3. GET  {baseUrl}/files/retrieve?file_id=           -> download_url (1h TTL)
 *
 * Success is signalled by `base_resp.status_code === 0`; HTTP 200 alone does
 * not mean success. Step 3's URL expires after an hour, so it is fetched only
 * once the task reports Success.
 */
import type { SqliteStore } from '../../sqliteStore';
import { findMediaEntry, listMediaEntries } from './store';
import { forgetMediaTaskTarget, rememberMediaTaskTarget } from './taskRegistry';
import {
  type MediaCancelOutput,
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

const VIDEO_GENERATION_PATH = '/video_generation';
const QUERY_VIDEO_GENERATION_PATH = '/query/video_generation';
const FILES_RETRIEVE_PATH = '/files/retrieve';
const DEFAULT_REQUEST_TIMEOUT_MS = 60 * 1000;

/** MiniMax's native status strings (first letter capitalised). */
const STATUS_PREPARING = 'Preparing';
const STATUS_QUEUEING = 'Queueing';
const STATUS_PROCESSING = 'Processing';
const STATUS_SUCCESS = 'Success';
const STATUS_FAIL = 'Fail';

/** MiniMax error codes worth a dedicated message. */
const ERROR_CODE_MESSAGES: Record<number, string> = {
  1002: 'MiniMax rate limit reached. Retry later.',
  1004: 'MiniMax authentication failed. Check the API key.',
  1008: 'MiniMax account balance is insufficient.',
  1026: 'The prompt was rejected by MiniMax content moderation.',
  1027: 'The generated video was rejected by MiniMax content moderation.',
};

/** Params forwarded verbatim to MiniMax's create-task call. */
const MINIMAX_VIDEO_PARAMS = [
  'duration',
  'resolution',
  'prompt_optimizer',
  'aigc_watermark',
  'callback_url',
  'first_frame_image',
  'last_frame_image',
  'subject_reference',
] as const;

interface MiniMaxBaseResp {
  status_code?: number;
  status_msg?: string;
}

interface MiniMaxEnvelope {
  base_resp?: MiniMaxBaseResp;
  task_id?: string;
  status?: string;
  file_id?: string;
  video_width?: number;
  video_height?: number;
  file?: { download_url?: string; file_id?: string };
}

const takeString = (value: unknown): string | undefined => (
  typeof value === 'string' && value.trim() ? value.trim() : undefined
);

const joinUrl = (baseUrl: string, path: string): string => {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (!trimmed) {
    throw new MediaProviderError(
      'MEDIA_PROVIDER_BASE_URL_MISSING',
      'Video provider baseUrl is not configured.',
    );
  }
  return `${trimmed}${path}`;
};

/** MiniMax reports failure inside a 200 response, so unwrap `base_resp` first. */
const assertBaseRespOk = (payload: MiniMaxEnvelope, stage: string): void => {
  const statusCode = payload.base_resp?.status_code;
  if (statusCode === undefined || statusCode === 0) return;

  const upstreamMessage = takeString(payload.base_resp?.status_msg) ?? `status_code ${statusCode}`;
  const known = ERROR_CODE_MESSAGES[statusCode];
  throw new MediaProviderError(
    `MINIMAX_${statusCode}`,
    `${stage} failed: ${known ?? upstreamMessage}`,
  );
};

const mapStatus = (status: string | undefined): MediaTaskStatus => {
  switch (status) {
    case STATUS_PREPARING:
    case STATUS_QUEUEING:
      return MediaTaskStatus.Queued;
    case STATUS_PROCESSING:
      return MediaTaskStatus.Running;
    case STATUS_SUCCESS:
      return MediaTaskStatus.Succeeded;
    case STATUS_FAIL:
      return MediaTaskStatus.Failed;
    default:
      return MediaTaskStatus.Running;
  }
};

/** Maps normalised generation params onto MiniMax's request body. */
const toCreateBody = (
  modelId: string,
  prompt: string,
  params: Record<string, unknown>,
): Record<string, unknown> => {
  const body: Record<string, unknown> = { model: modelId, prompt };
  for (const key of MINIMAX_VIDEO_PARAMS) {
    if (params[key] !== undefined && params[key] !== null) {
      body[key] = params[key];
    }
  }

  // `durationSeconds` is the tool-facing spelling; MiniMax wants `duration`.
  if (body.duration === undefined && typeof params.durationSeconds === 'number') {
    body.duration = params.durationSeconds;
  }

  // Reference/first-frame images arrive already resolved into params.images.
  if (body.first_frame_image === undefined && typeof params.firstFrame === 'string') {
    body.first_frame_image = params.firstFrame;
  }
  if (body.last_frame_image === undefined && typeof params.lastFrame === 'string') {
    body.last_frame_image = params.lastFrame;
  }
  return body;
};

export interface MiniMaxVideoAdapterOptions {
  store: SqliteStore;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export const createMiniMaxVideoAdapter = (options: MiniMaxVideoAdapterOptions): MediaProvider => {
  const { store } = options;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  const request = async (
    url: string,
    apiKey: string,
    stage: string,
    init?: RequestInit,
  ): Promise<MiniMaxEnvelope> => {
    if (!apiKey) {
      throw new MediaProviderError(
        'MEDIA_PROVIDER_API_KEY_MISSING',
        `${stage} requires an API key, but none is configured for this video provider.`,
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          ...(init?.headers as Record<string, string> | undefined),
        },
        signal: controller.signal,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new MediaProviderError(
        'MEDIA_PROVIDER_REQUEST_FAILED',
        `${stage} request to "${url}" failed: ${message}`,
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let payload: MiniMaxEnvelope = {};
    if (text.trim()) {
      try {
        payload = JSON.parse(text) as MiniMaxEnvelope;
      } catch {
        throw new MediaProviderError(
          'MEDIA_PROVIDER_INVALID_RESPONSE',
          `${stage} returned non-JSON (HTTP ${response.status}).`,
        );
      }
    }

    if (!response.ok) {
      const upstreamMessage = takeString(payload.base_resp?.status_msg) ?? `HTTP ${response.status}`;
      throw new MediaProviderError(
        `MEDIA_PROVIDER_HTTP_${response.status}`,
        `${stage} failed: ${upstreamMessage}`,
      );
    }

    assertBaseRespOk(payload, stage);
    return payload;
  };

  /** Step 3: turn a MiniMax `file_id` into a downloadable URL. */
  const retrieveDownloadUrl = async (
    fileId: string,
    target: MediaProviderTarget,
  ): Promise<string> => {
    const url = `${joinUrl(target.baseUrl, FILES_RETRIEVE_PATH)}?file_id=${encodeURIComponent(fileId)}`;
    const payload = await request(url, target.apiKey, 'MiniMax video retrieve');
    const downloadUrl = takeString(payload.file?.download_url);
    if (!downloadUrl) {
      throw new MediaProviderError(
        'MEDIA_PROVIDER_EMPTY_RESULT',
        'MiniMax returned no download URL for the generated video.',
      );
    }
    return downloadUrl;
  };

  const listModels = (): MediaProviderModel[] => (
    listMediaEntries(store, MediaProviderKind.Video).map(entry => ({
      modelId: entry.modelId,
      displayName: entry.displayName,
      providerKey: entry.key,
      ...(entry.capabilities ? { capabilities: entry.capabilities } : {}),
    }))
  );

  const resolveTarget = (modelId: string): MediaProviderTarget | undefined => {
    const entry = findMediaEntry(store, MediaProviderKind.Video, modelId);
    if (!entry) return undefined;
    return {
      providerKey: entry.key,
      baseUrl: entry.baseUrl,
      apiKey: entry.apiKey,
      modelId: entry.modelId,
      displayName: entry.displayName,
    };
  };

  /** Step 1: create the task. Returns immediately with MiniMax's task id. */
  const generate = async (input: MediaGenerateInput): Promise<MediaGenerateOutput> => {
    const { target, prompt, params } = input;
    const modelId = target.modelId || target.providerKey;
    const url = joinUrl(target.baseUrl, VIDEO_GENERATION_PATH);

    const payload = await request(url, target.apiKey, 'MiniMax video generation', {
      method: 'POST',
      body: JSON.stringify(toCreateBody(modelId, prompt, params)),
    });

    const taskId = takeString(payload.task_id);
    if (!taskId) {
      throw new MediaProviderError(
        'MEDIA_PROVIDER_EMPTY_RESULT',
        'MiniMax accepted the request but returned no task_id.',
      );
    }

    // Async provider: main.ts needs the target back to poll this task later.
    rememberMediaTaskTarget(store, taskId, target);

    return {
      taskId,
      upstreamTaskId: taskId,
      status: MediaTaskStatus.Queued,
      resultUrls: [],
      model: modelId,
      upstreamModel: modelId,
    };
  };

  /** Steps 2 + 3: poll status, and resolve the URL once it succeeds. */
  const status = async (taskId: string, target: MediaProviderTarget): Promise<MediaStatusOutput> => {
    const url = `${joinUrl(target.baseUrl, QUERY_VIDEO_GENERATION_PATH)}?task_id=${encodeURIComponent(taskId)}`;
    const payload = await request(url, target.apiKey, 'MiniMax video query');

    let taskStatus = mapStatus(payload.status);
    const resultUrls: string[] = [];
    let errorMessage: string | undefined;

    if (taskStatus === MediaTaskStatus.Succeeded) {
      const fileId = takeString(payload.file_id);
      if (fileId) {
        resultUrls.push(await retrieveDownloadUrl(fileId, target));
      } else {
        // Success without a file id means there is nothing to download, which
        // is a terminal failure rather than a state worth polling again.
        taskStatus = MediaTaskStatus.Failed;
        errorMessage = 'MiniMax reported success but returned no file_id.';
      }
    } else if (taskStatus === MediaTaskStatus.Failed) {
      errorMessage = takeString(payload.base_resp?.status_msg) ?? 'MiniMax video generation failed.';
    }

    return {
      taskId,
      upstreamTaskId: taskId,
      status: taskStatus,
      resultUrls,
      model: target.modelId || target.providerKey,
      upstreamModel: target.modelId || target.providerKey,
      ...(errorMessage ? { errorMessage } : {}),
    };
  };

  /**
   * MiniMax exposes no cancel endpoint; the tool's cancel contract is
   * satisfied by dropping the local tracking so polling stops.
   */
  const cancel = async (taskId: string): Promise<MediaCancelOutput> => {
    forgetMediaTaskTarget(store, taskId);
    return {
      taskId,
      cancelled: true,
    };
  };

  return {
    kind: MediaProviderKind.Video,
    resolver: {
      listModels,
      resolveTarget,
      canServe: (modelId: string) => resolveTarget(modelId) !== undefined,
    },
    generate,
    status,
    cancel,
  };
};
