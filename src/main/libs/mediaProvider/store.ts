/**
 * Local storage for user-configured media providers.
 *
 * Lives in its own `kv` key so it never touches `app_config.providers`, which
 * is consumed by the chat/OpenClaw paths. Media models are configured by hand
 * (plan A): the user fills baseUrl / apiKey / modelId per entry on the settings
 * page (`MediaProviderSettingsSection`), and the model list is derived entirely
 * from this config with no network round-trip.
 *
 * The API key is encrypted with Electron `safeStorage` before it reaches the
 * kv table, so a plaintext key is never written to disk. When encryption is
 * unavailable the key is stored as an empty string rather than plaintext: the
 * adapter already reports a user-visible "no API key" error, which is strictly
 * better than silently leaking the secret.
 */
import {
  EMPTY_MEDIA_PROVIDERS_CONFIG,
  isRecord,
  MEDIA_PROVIDER_KINDS,
  type MediaProviderApiKeyIssue,
  type MediaProviderEntry,
  type MediaProvidersConfig,
  normalizeMediaProviderEntry,
} from '../../../shared/cowork/mediaProviders';
import type { SqliteStore } from '../../sqliteStore';
import type { MediaProviderKind as MediaProviderKindType } from './types';

export const MEDIA_PROVIDERS_STORE_KEY = 'mediaProviders';

export {
  EMPTY_MEDIA_PROVIDERS_CONFIG,
  type MediaProviderEntry,
  type MediaProvidersConfig,
};

const KIND_ORDER = MEDIA_PROVIDER_KINDS;

/** Minimal `safeStorage` surface, injected so tests need no Electron runtime. */
export interface MediaProviderCrypto {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/**
 * Process-wide crypto handle, registered once at startup. Held in a module
 * variable so every existing read path (`findMediaEntry`, `listMediaEntries`,
 * and the adapters that call them) decrypts correctly without threading a
 * crypto argument through the whole call graph.
 */
let mediaProviderCrypto: MediaProviderCrypto | undefined;

export const setMediaProviderCrypto = (crypto: MediaProviderCrypto | undefined): void => {
  mediaProviderCrypto = crypto;
};

/** On-disk shape: only `apiKey` differs from the in-memory contract. */
interface StoredMediaProviderEntry extends Omit<MediaProviderEntry, 'apiKey'> {
  /** Base64 of the `safeStorage`-encrypted key, or '' when unavailable. */
  encryptedApiKey: string;
}

const encryptApiKey = (
  crypto: MediaProviderCrypto | undefined,
  apiKey: string,
): string => {
  if (!apiKey) return '';
  if (!crypto?.isEncryptionAvailable()) return '';
  try {
    return crypto.encryptString(apiKey).toString('base64');
  } catch (error) {
    console.warn('[MediaProvider] failed to encrypt API key; storing it empty:', error);
    return '';
  }
};

/** Outcome of trying to decrypt a persisted API key. */
type ApiKeyReadResult =
  | { status: 'ok'; apiKey: string }
  /** No key was ever stored, or the key was stored as unset. */
  | { status: 'absent' }
  /** A key is on disk but could not be read; it must not be overwritten. */
  | { status: 'unreadable'; issue: MediaProviderApiKeyIssue };

/**
 * Decrypts a persisted API key, distinguishing "never had a key" from "a key
 * exists but cannot be read right now".
 *
 * That distinction is the whole point: if an unreadable key is reported as an
 * absent one, the settings page shows a blank field, the user saves an
 * unrelated edit, and the ciphertext is overwritten with an empty string — an
 * irreversible loss. Reporting `unreadable` lets the write path refuse and the
 * UI ask the user to re-enter the key.
 */
const readApiKey = (
  crypto: MediaProviderCrypto | undefined,
  encryptedApiKey: unknown,
): ApiKeyReadResult => {
  if (typeof encryptedApiKey !== 'string' || !encryptedApiKey) {
    return { status: 'absent' };
  }
  if (!crypto?.isEncryptionAvailable()) {
    return { status: 'unreadable', issue: 'encryption-unavailable' };
  }
  try {
    return { status: 'ok', apiKey: crypto.decryptString(Buffer.from(encryptedApiKey, 'base64')) };
  } catch (error) {
    // Most likely the OS keychain changed (restored backup, different machine).
    // Treat it as unreadable rather than unset so the existing key is preserved
    // until the user supplies a new one.
    console.warn('[MediaProvider] failed to decrypt API key:', error);
    return { status: 'unreadable', issue: 'undecryptable' };
  }
};

const toStoredEntry = (
  crypto: MediaProviderCrypto | undefined,
  entry: MediaProviderEntry,
): StoredMediaProviderEntry => {
  const {
    apiKey,
    apiKeyIssue: _apiKeyIssue,
    apiKeyStored: _apiKeyStored,
    clearApiKey: _clearApiKey,
    preservedCiphertext,
    ...rest
  } = entry;

  // A preserved ciphertext means the key could not be read on this machine and
  // was never shown to the user: write it back untouched rather than replacing
  // it with the empty visible value.
  const encryptedApiKey = preservedCiphertext && !apiKey
    ? preservedCiphertext
    : encryptApiKey(crypto, apiKey);

  return { ...rest, encryptedApiKey };
};

const fromStoredEntry = (
  crypto: MediaProviderCrypto | undefined,
  value: unknown,
): MediaProviderEntry | undefined => {
  if (!isRecord(value)) return undefined;
  const { encryptedApiKey, ...rest } = value;
  // Reuse the shared entry rules so the read and write paths cannot drift.
  const entry = normalizeMediaProviderEntry(rest);
  if (!entry) return undefined;

  // Entries written before API keys were encrypted carry a plaintext `apiKey`
  // and no `encryptedApiKey`. Reading them through the decrypt path would blank
  // the key and silently break every request, so they are passed through as-is
  // and re-encrypted the next time the settings page saves.
  const hasEncryptedKey = typeof encryptedApiKey === 'string' && encryptedApiKey !== '';
  if (!hasEncryptedKey) {
    // A legacy plaintext key counts as stored, so the form shows the same
    // "configured" affordance it would for an encrypted one.
    return entry.apiKey ? { ...entry, apiKeyStored: true } : entry;
  }

  const read = readApiKey(crypto, encryptedApiKey);
  if (read.status === 'ok') {
    return { ...entry, apiKey: read.apiKey, apiKeyStored: true };
  }
  if (read.status === 'unreadable') {
    // A key is on disk, it just cannot be read here. Flag it so the UI can
    // explain the situation and the write path can preserve the ciphertext.
    return { ...entry, apiKey: '', apiKeyStored: true, apiKeyIssue: read.issue };
  }
  return { ...entry, apiKey: '' };
};

/** True when the stored entry still carries a plaintext `apiKey`. */
const hasLegacyPlaintextKey = (value: unknown): boolean => (
  isRecord(value)
  && typeof value.apiKey === 'string'
  && value.apiKey !== ''
  && (typeof value.encryptedApiKey !== 'string' || value.encryptedApiKey === '')
);

/**
 * Rewrites legacy plaintext entries in encrypted form.
 *
 * Called only when encryption is available and a plaintext key was actually
 * seen, so a machine without a keyring keeps its plaintext rather than having
 * it silently replaced by an empty string. Failures are swallowed: this is an
 * opportunistic cleanup, and it must never turn a working read into an error.
 */
const migrateLegacyPlaintextKeys = (
  store: SqliteStore,
  raw: Record<string, unknown>,
  crypto: MediaProviderCrypto,
): void => {
  try {
    const config = KIND_ORDER.reduce<MediaProvidersConfig>((acc, kind) => {
      const list = raw[kind];
      acc[kind] = Array.isArray(list)
        ? list.map(item => fromStoredEntry(crypto, item)).filter((e): e is MediaProviderEntry => Boolean(e))
        : [];
      return acc;
    }, { ...EMPTY_MEDIA_PROVIDERS_CONFIG });
    writeMediaProvidersConfig(store, config, crypto);
  } catch (error) {
    console.warn('[MediaProvider] failed to migrate plaintext API keys:', error);
  }
};

/**
 * Reads the media provider config from the store, tolerating missing or
 * malformed data by falling back to an empty list per kind. Never throws:
 * a broken config must degrade to "no models", not break the tool callback.
 */
export const readMediaProvidersConfig = (
  store: SqliteStore,
  crypto: MediaProviderCrypto | undefined = mediaProviderCrypto,
): MediaProvidersConfig => {
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

  const hasLegacyKey = KIND_ORDER.some(kind => (
    Array.isArray(raw[kind]) && (raw[kind] as unknown[]).some(hasLegacyPlaintextKey)
  ));

  const config = KIND_ORDER.reduce<MediaProvidersConfig>((acc, kind) => {
    const list = raw[kind];
    if (!Array.isArray(list)) {
      acc[kind] = [];
      return acc;
    }

    const entries: MediaProviderEntry[] = [];
    const seen = new Set<string>();
    for (const item of list) {
      const entry = fromStoredEntry(crypto, item);
      if (!entry || seen.has(entry.key)) continue;
      seen.add(entry.key);
      entries.push(entry);
    }
    acc[kind] = entries;
    return acc;
  }, { ...EMPTY_MEDIA_PROVIDERS_CONFIG });

  if (hasLegacyKey && crypto?.isEncryptionAvailable()) {
    migrateLegacyPlaintextKeys(store, raw, crypto);
  }

  return config;
};

export const writeMediaProvidersConfig = (
  store: SqliteStore,
  config: MediaProvidersConfig,
  crypto: MediaProviderCrypto | undefined = mediaProviderCrypto,
): void => {
  const stored = KIND_ORDER.reduce<Record<string, StoredMediaProviderEntry[]>>((acc, kind) => {
    acc[kind] = (config[kind] ?? []).map(entry => toStoredEntry(crypto, entry));
    return acc;
  }, {});
  store.set(MEDIA_PROVIDERS_STORE_KEY, stored);
};

/**
 * Fills in a missing API key on an incoming config from the stored one.
 *
 * The settings page cannot always send the key back — it is either encrypted
 * and therefore unreadable on this machine, or the secret was never rendered
 * into the field. Persisting the blank value would destroy the stored key, so
 * a blank incoming key means "keep what is on disk", matched by entry key and
 * falling back to modelId to survive a rename of the user-facing key.
 *
 * The stored ciphertext is copied verbatim when it cannot be decrypted, so an
 * unreadable key survives a save untouched. Clearing a key is expressed by
 * removing the entry instead.
 */
export const mergeMediaProviderApiKeys = (
  store: SqliteStore,
  incoming: MediaProvidersConfig,
): MediaProvidersConfig => {
  let raw: unknown;
  try {
    raw = store.get<unknown>(MEDIA_PROVIDERS_STORE_KEY);
  } catch (error) {
    console.warn('[MediaProvider] failed to read config while merging keys:', error);
    return incoming;
  }
  if (!isRecord(raw)) return incoming;

  return KIND_ORDER.reduce<MediaProvidersConfig>((acc, kind) => {
    const storedList = Array.isArray(raw[kind]) ? (raw[kind] as unknown[]) : [];
    const byKey = new Map<string, string>();
    for (const item of storedList) {
      if (!isRecord(item)) continue;
      const ciphertext = typeof item.encryptedApiKey === 'string' ? item.encryptedApiKey : '';
      if (!ciphertext) continue;
      // Index under both the user-facing key and the model id: an incoming
      // entry may have renamed its key, and then only modelId still matches.
      for (const candidate of [item.key, item.modelId]) {
        if (typeof candidate === 'string' && candidate && !byKey.has(candidate)) {
          byKey.set(candidate, ciphertext);
        }
      }
    }

    acc[kind] = (incoming[kind] ?? []).map((entry) => {
      // An explicit clear wins over everything: the user asked for removal.
      if (entry.clearApiKey) {
        const { clearApiKey: _clearApiKey, ...cleared } = entry;
        return { ...cleared, apiKey: '', apiKeyStored: false, apiKeyIssue: undefined };
      }

      if (entry.apiKey) {
        const { clearApiKey: _clearApiKey, ...kept } = entry;
        return kept;
      }

      const ciphertext = byKey.get(entry.key) ?? byKey.get(entry.modelId);
      const { clearApiKey: _clearApiKey, ...rest } = entry;
      return ciphertext
        ? { ...rest, apiKeyIssue: undefined, preservedCiphertext: ciphertext }
        : rest;
    });
    return acc;
  }, { ...EMPTY_MEDIA_PROVIDERS_CONFIG });
};

/**
 * Strips secrets so a config can cross the IPC boundary.
 *
 * The renderer never receives a plaintext key: it only learns whether one is
 * stored (`apiKeyStored`). A key typed into the form travels the other way and
 * is merged in by `mergeMediaProviderApiKeys`, which also carries an unreadable
 * ciphertext forward instead of blanking it.
 */
export const toRendererMediaProvidersConfig = (
  config: MediaProvidersConfig,
): MediaProvidersConfig => KIND_ORDER.reduce<MediaProvidersConfig>((acc, kind) => {
  acc[kind] = (config[kind] ?? []).map((entry) => {
    const {
      apiKey,
      clearApiKey: _clearApiKey,
      preservedCiphertext: _preservedCiphertext,
      ...rest
    } = entry;
    const apiKeyStored = Boolean(entry.apiKeyStored || apiKey);
    return { ...rest, apiKey: '', ...(apiKeyStored ? { apiKeyStored: true } : {}) };
  });
  return acc;
}, { ...EMPTY_MEDIA_PROVIDERS_CONFIG });

/** Config safe to hand to the renderer, with every secret stripped. */
export const readMediaProvidersConfigForRenderer = (
  store: SqliteStore,
  crypto: MediaProviderCrypto | undefined = mediaProviderCrypto,
): MediaProvidersConfig => toRendererMediaProvidersConfig(readMediaProvidersConfig(store, crypto));

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
