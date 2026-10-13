/**
 * Media provider adapter layer.
 *
 * Replaces the former LobsterAI server round-trip for image/video generation.
 * `handleMediaGenerationCallback` in `main.ts` is the only caller.
 */

export const MediaProviderKind = {
  Image: 'image',
  Video: 'video',
} as const;
export type MediaProviderKind = typeof MediaProviderKind[keyof typeof MediaProviderKind];

export const MediaTaskStatus = {
  Queued: 'queued',
  Running: 'running',
  Succeeded: 'succeeded',
  Failed: 'failed',
  Cancelled: 'cancelled',
} as const;
export type MediaTaskStatus = typeof MediaTaskStatus[keyof typeof MediaTaskStatus];

/** One selectable media model, resolved from a user-configured provider entry. */
export interface MediaProviderModel {
  /** Model id as sent to the upstream API. */
  modelId: string;
  /** Human-readable name for UI and tool output. */
  displayName: string;
  /** Provider key in `app_config.providers`. */
  providerKey: string;
  /** Free-form description of supported parameters, surfaced by `action=list`. */
  capabilities?: string;
  /** JSON-serialisable description of supported parameters. */
  parameterSpec?: Record<string, unknown>;
}

/** Credentials + endpoint resolved from a single provider entry. */
export interface MediaProviderTarget {
  providerKey: string;
  baseUrl: string;
  apiKey: string;
  modelId: string;
  displayName: string;
}

export interface MediaGenerateInput {
  target: MediaProviderTarget;
  prompt: string;
  /** Generation params already normalised by `main.ts` (images, resolution, ...). */
  params: Record<string, unknown>;
}

export interface MediaGenerateOutput {
  /**
   * Upstream task handle. Synchronous providers (OpenAI-compatible images)
   * return a synthetic id; the task is already terminal in `status`.
   */
  taskId: string;
  /** Upstream-native task id when it differs from `taskId`. */
  upstreamTaskId?: string;
  status: MediaTaskStatus;
  /** Generated media URLs or local paths. */
  resultUrls: string[];
  model: string;
  upstreamModel?: string;
  modelSelectionReason?: string;
  errorMessage?: string;
  progress?: number;
}

export interface MediaStatusOutput {
  taskId: string;
  upstreamTaskId?: string;
  status: MediaTaskStatus;
  resultUrls: string[];
  model: string;
  upstreamModel?: string;
  modelSelectionReason?: string;
  errorMessage?: string;
  progress?: number;
}

export interface MediaCancelOutput {
  taskId: string;
  cancelled: boolean;
  errorMessage?: string;
}

/** A provider entry that can serve one media kind. */
export interface MediaProviderResolver {
  /** List models across every enabled provider entry of this kind. */
  listModels(): MediaProviderModel[];
  /** Resolve the credentials + endpoint for a specific model id. */
  resolveTarget(modelId: string): MediaProviderTarget | undefined;
  /** Syntactic check used when the model comes from the user selection. */
  canServe(modelId: string): boolean;
}

export interface MediaProvider {
  readonly kind: MediaProviderKind;
  readonly resolver: MediaProviderResolver;
  generate(input: MediaGenerateInput): Promise<MediaGenerateOutput>;
  /** Poll/report a task. Synchronous providers return the stored terminal result. */
  status(taskId: string, target: MediaProviderTarget): Promise<MediaStatusOutput>;
  /** Optional; only task-based providers (video) implement a real cancel. */
  cancel?(taskId: string, target: MediaProviderTarget): Promise<MediaCancelOutput>;
}

/** Thrown when a provider is misconfigured or returns a protocol error. */
export class MediaProviderError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'MediaProviderError';
    this.code = code;
  }
}
