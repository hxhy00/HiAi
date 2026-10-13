/**
 * Local storage for user-configured media providers.
 *
 * Lives in its own `kv` key so it never touches `app_config.providers`, which
 * is consumed by the chat/OpenClaw paths. Media models are configured by hand
 * (plan A): the user fills baseUrl / apiKey / modelId per entry, and the model
 * list is derived entirely from this config with no network round-trip.
 *
 * UI for editing these entries is not part of this change.
 */
import type { SqliteStore } from '../../sqliteStore';
import {
  MediaProviderKind,
  type MediaProviderKind as MediaProviderKindType,
} from './types';

export const MEDIA_PROVIDERS_STORE_KEY = 'mediaProviders';

/** One user-configured media model entry. */
export interface MediaProviderEntry {
  /** Stable user-facing key, unique within its kind. */
  key: string;
  /** Human-readable name surfaced by `action=list`. */
  displayName: string;
  /** Provider endpoint root, e.g. `https://api.openai.com/v1`. */
  baseUrl: string;
  apiKey: string;
  /** Model id sent to the upstream API. */
  modelId: string;
  /** Optional free-form capability description surfaced by `action=list`. */
  capabilities?: string;
}

export interface MediaProvidersConfig {
  [MediaProviderKind.Image]: MediaProviderEntry[];
  [MediaProviderKind.Video]: MediaProviderEntry[];
}

const KIND_ORDER: MediaProviderKindType[] = [
  MediaProviderKind.Image,
  MediaProviderKind.Video,
];

export const EMPTY_MEDIA_PROVIDERS_CONFIG: MediaProvidersConfig = {
  [MediaProviderKind.Image]: [],
  [MediaProviderKind.Video]: [],
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const normalizeString = (value: unknown): string => (
  typeof value === 'string' ? value.trim() : ''
);

const normalizeEntry = (value: unknown): MediaProviderEntry | undefined => {
  if (!isRecord(value)) return undefined;

  const modelId = normalizeString(value.modelId);
  if (!modelId) return undefined;

  const baseUrl = normalizeString(value.baseUrl);
  const key = normalizeString(value.key) || modelId;
  const displayName = normalizeString(value.displayName) || modelId;
  const capabilities = normalizeString(value.capabilities);

  return {
    key,
    displayName,
    baseUrl,
    apiKey: normalizeString(value.apiKey),
    modelId,
    ...(capabilities ? { capabilities } : {}),
  };
};

const normalizeEntryList = (value: unknown): MediaProviderEntry[] => {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const entries: MediaProviderEntry[] = [];
  for (const item of value) {
    const entry = normalizeEntry(item);
    if (!entry || seen.has(entry.key)) continue;
    seen.add(entry.key);
    entries.push(entry);
  }
  return entries;
};

/**
 * Reads the media provider config from the store, tolerating missing or
 * malformed data by falling back to an empty list per kind. Never throws:
 * a broken config must degrade to "no models", not break the tool callback.
 */
export const readMediaProvidersConfig = (store: SqliteStore): MediaProvidersConfig => {
  let raw: unknown;
  try {
    raw = store.get<unknown>(MEDIA_PROVIDERS_STORE_KEY);
  } catch (error) {
    console.warn('[MediaProvider] failed to read media provider config:', error);
    return { ...EMPTY_MEDIA_PROVIDERS_CONFIG };
  }

  if (!isRecord(raw)) {
    return { ...EMPTY_MEDIA_PROVIDERS_CONFIG };
  }

  return KIND_ORDER.reduce<MediaProvidersConfig>((acc, kind) => {
    acc[kind] = normalizeEntryList(raw[kind]);
    return acc;
  }, { ...EMPTY_MEDIA_PROVIDERS_CONFIG });
};

export const writeMediaProvidersConfig = (
  store: SqliteStore,
  config: MediaProvidersConfig,
): void => {
  store.set(MEDIA_PROVIDERS_STORE_KEY, config);
};

/** Model ids for one kind, in configured order. */
export const listMediaEntries = (
  store: SqliteStore,
  kind: MediaProviderKindType,
): MediaProviderEntry[] => readMediaProvidersConfig(store)[kind];

/**
 * Resolves one entry by key, then by modelId, so both a `action=list` model id
 * and a user-facing entry key resolve to the same target.
 */
export const findMediaEntry = (
  store: SqliteStore,
  kind: MediaProviderKindType,
  modelId: string,
): MediaProviderEntry | undefined => {
  const normalized = modelId.trim();
  if (!normalized) return undefined;

  const entries = listMediaEntries(store, kind);
  return entries.find(entry => entry.key === normalized)
    ?? entries.find(entry => entry.modelId === normalized);
};
