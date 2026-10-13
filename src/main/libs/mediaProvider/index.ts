/**
 * Media provider registry.
 *
 * `main.ts` only forwards to this layer; all upstream protocol knowledge lives
 * in the per-kind adapters. Only the image kind has a local adapter so far —
 * the video path still goes through the LobsterAI server and is wired up in a
 * later change.
 */
import type { SqliteStore } from '../../sqliteStore';
import { createOpenAIImageAdapter } from './openaiCompatImage';
import { type MediaProvider,MediaProviderKind } from './types';

export * from './store';
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
 */
export const initMediaProviders = (options: MediaProviderInitOptions): void => {
  registerMediaProvider(createOpenAIImageAdapter({
    store: options.store,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  }));
};

export const getImageMediaProvider = (): MediaProvider | undefined => (
  getMediaProvider(MediaProviderKind.Image)
);
