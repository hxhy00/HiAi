/**
 * Media provider registry.
 *
 * `main.ts` only forwards to this layer; all upstream protocol knowledge lives
 * in the per-kind adapters: OpenAI-compatible images and MiniMax video.
 */
import type { SqliteStore } from '../../sqliteStore';
import { createMiniMaxVideoAdapter } from './minimaxVideo';
import { createOpenAIImageAdapter } from './openaiCompatImage';
import { type MediaProvider,MediaProviderKind } from './types';

export * from './store';
export * from './taskRegistry';
export * from './types';

const providers = new Map<string, MediaProvider>();

export const registerMediaProvider = (provider: MediaProvider): void => {
  providers.set(provider.kind, provider);
};

export const getMediaProvider = (kind: string): MediaProvider | undefined => (
  providers.get(kind)
);

export interface MediaProviderInitOptions {
  store: SqliteStore;
  fetchImpl?: typeof fetch;
}

/**
 * Registers the adapters that are available locally. Idempotent: calling it
 * again replaces the registrations, so startup re-init is safe.
 *
 * Must be called after the SQLite store exists (`initStore()` inside
 * `initApp()`), because adapters read provider entries at init time.
 */
export const initMediaProviders = (options: MediaProviderInitOptions): void => {
  const shared = {
    store: options.store,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  };
  registerMediaProvider(createOpenAIImageAdapter(shared));
  registerMediaProvider(createMiniMaxVideoAdapter(shared));
};

export const getImageMediaProvider = (): MediaProvider | undefined => (
  getMediaProvider(MediaProviderKind.Image)
);

export const getVideoMediaProvider = (): MediaProvider | undefined => (
  getMediaProvider(MediaProviderKind.Video)
);
