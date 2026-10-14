/**
 * Shared contract for user-configured media providers.
 *
 * These entries are filled in by hand on the settings page (baseUrl / apiKey /
 * modelId per entry). The model list the media tools expose is derived purely
 * from this config, with no network round-trip and no LobsterAI server
 * involvement.
 *
 * This module must stay free of Electron/Node imports so both the main process
 * and the renderer can depend on it.
 */

export const MediaProviderKind = {
  Image: 'image',
  Video: 'video',
} as const;
export type MediaProviderKind = typeof MediaProviderKind[keyof typeof MediaProviderKind];

export const MEDIA_PROVIDER_KINDS: ReadonlyArray<MediaProviderKind> = [
  MediaProviderKind.Image,
  MediaProviderKind.Video,
];

/**
 * Why a stored API key could not be read.
 *
 * Both cases mean "a key is on disk but cannot be decrypted right now", as
 * opposed to "this entry never had a key". The distinction matters: saving an
 * entry whose key cannot be read would overwrite the ciphertext with an empty
 * string and lose it for good, so the entry is flagged and the user is asked
 * to re-enter the key.
 */
export type MediaProviderApiKeyIssue = 'undecryptable' | 'encryption-unavailable';

/** One user-configured media model entry. */
export interface MediaProviderEntry {
  /** Stable user-facing key, unique within its kind. */
  key: string;
  /** Human-readable name surfaced by `action=list`. */
  displayName: string;
  /** Provider endpoint root, e.g. `https://api.openai.com/v1`. */
  baseUrl: string;
  /**
   * The key value. When read from the store this is always empty: the plaintext
   * secret is never sent to the renderer. It is only populated by the settings
   * form when the user types a new key, and it is what gets persisted.
   */
  apiKey: string;
  /** Model id sent to the upstream API. */
  modelId: string;
  /** Optional free-form capability description surfaced by `action=list`. */
  capabilities?: string;
  /**
   * Read-only flag set by the storage layer when a key is on disk for this
   * entry. Lets the form show "configured" without ever seeing the secret, and
   * keeps the plaintext from crossing the IPC boundary.
   */
  apiKeyStored?: boolean;
  /**
   * Read-only diagnostic set by the storage layer when the persisted key could
   * not be decrypted. Never persisted; ignored by the normalizer.
   */
  apiKeyIssue?: MediaProviderApiKeyIssue;
  /**
   * Set by the form when the user explicitly clears the API key. Needed
   * because an empty `apiKey` normally means "keep the stored key"; without
   * this flag there would be no way to express deliberate removal.
   */
  clearApiKey?: boolean;
  /**
   * Main-process only. Carries a stored ciphertext that must be written back
   * unchanged when the key could not be read, so a save cannot destroy it.
   * Stripped by the normalizer and never sent to the renderer.
   */
  preservedCiphertext?: string;
}

export interface MediaProvidersConfig {
  [MediaProviderKind.Image]: MediaProviderEntry[];
  [MediaProviderKind.Video]: MediaProviderEntry[];
}

export const EMPTY_MEDIA_PROVIDERS_CONFIG: MediaProvidersConfig = {
  [MediaProviderKind.Image]: [],
  [MediaProviderKind.Video]: [],
};

/**
 * Window event used to open the media provider settings tab from anywhere in
 * the renderer. The media picker lives deep inside the prompt input, so
 * threading a callback through every intermediate component would be far more
 * churn than a single broadcast event.
 */
export const MediaProviderUiEvent = {
  OpenSettings: 'lobster:media-provider:open-settings',
} as const;

/** Shared narrow-object guard, so every boundary check behaves identically. */
export const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const readString = (value: unknown): string => (
  typeof value === 'string' ? value.trim() : ''
);

/**
 * Accepts only `http:`/`https:` endpoints.
 *
 * A blank baseUrl is allowed on purpose: the form is filled in progressively,
 * so saving a half-finished row must not drop it. The adapter reports a
 * user-visible error at generation time when the endpoint is still missing.
 * Any other protocol (`file:`, `javascript:`, ...) is rejected outright,
 * because it would otherwise be handed straight to `fetch`.
 */
const isAcceptableBaseUrl = (value: string): boolean => {
  if (!value) return true;
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
};

/**
 * Normalizes a single entry. Exported so the storage layer can reuse the exact
 * same field rules instead of duplicating them.
 */
export const normalizeMediaProviderEntry = (
  value: unknown,
): MediaProviderEntry | undefined => {
  if (!isRecord(value)) return undefined;

  const modelId = readString(value.modelId);
  if (!modelId) return undefined;

  const baseUrl = readString(value.baseUrl);
  if (!isAcceptableBaseUrl(baseUrl)) return undefined;

  const capabilities = readString(value.capabilities);
  return {
    key: readString(value.key) || modelId,
    displayName: readString(value.displayName) || modelId,
    baseUrl,
    apiKey: readString(value.apiKey),
    modelId,
    ...(capabilities ? { capabilities } : {}),
    // Purely presentational: it only tells the form whether to show the
    // "configured" affordance. A forged value changes nothing, because the
    // stored key is what actually gets used.
    ...(value.apiKeyStored === true ? { apiKeyStored: true } : {}),
    // Carries the user's explicit "remove my key" intent across the IPC
    // boundary; otherwise a blank apiKey would read as "keep the stored key".
    ...(value.clearApiKey === true ? { clearApiKey: true } : {}),
  };
};

/**
 * Normalizes a media provider config coming from an untrusted boundary (the
 * settings form, or the IPC payload it produces).
 *
 * Nothing is taken on faith: only known kinds are kept, every field is coerced
 * to a trimmed string, entries without a modelId or with a non-http(s) baseUrl
 * are dropped, and duplicate keys within a kind are collapsed. `displayName`
 * falls back to `modelId` and `key` falls back to `modelId`, matching the
 * tolerant read path.
 *
 * Returns undefined when the payload is not a plain object, so a malformed
 * write can never silently wipe a working config.
 */
export const normalizeMediaProvidersConfig = (
  value: unknown,
): MediaProvidersConfig | undefined => {
  if (!isRecord(value)) return undefined;

  const config: MediaProvidersConfig = {
    [MediaProviderKind.Image]: [],
    [MediaProviderKind.Video]: [],
  };

  for (const kind of MEDIA_PROVIDER_KINDS) {
    const list = value[kind];
    if (!Array.isArray(list)) continue;

    const seenKeys = new Set<string>();
    for (const raw of list) {
      const entry = normalizeMediaProviderEntry(raw);
      if (!entry || seenKeys.has(entry.key)) continue;
      seenKeys.add(entry.key);
      config[kind].push(entry);
    }
  }

  return config;
};
