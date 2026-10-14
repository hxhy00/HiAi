import { beforeEach, describe, expect, test } from 'vitest';

import {
  MediaProviderKind,
  type MediaProvidersConfig,
  normalizeMediaProvidersConfig,
} from '../../../shared/cowork/mediaProviders';
import type { SqliteStore } from '../../sqliteStore';
import {
  findMediaEntry,
  listMediaEntries,
  MEDIA_PROVIDERS_STORE_KEY,
  type MediaProviderCrypto,
  mergeMediaProviderApiKeys,
  readMediaProvidersConfig,
  setMediaProviderCrypto,
  toRendererMediaProvidersConfig,
  writeMediaProvidersConfig,
} from './store';

/** In-memory stand-in for the kv table. */
class FakeStore {
  private readonly values = new Map<string, unknown>();

  get<T = unknown>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  set<T = unknown>(key: string, value: T): void {
    this.values.set(key, value);
  }

  /** Raw persisted payload, for asserting on what actually hit disk. */
  raw<T = unknown>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }
}

/** Reversible fake that lets tests assert the key never lands in plaintext. */
class FakeCrypto implements MediaProviderCrypto {
  available = true;
  encryptCalls = 0;
  decryptCalls = 0;
  failEncrypt = false;
  failDecrypt = false;

  isEncryptionAvailable(): boolean {
    return this.available;
  }

  encryptString(plainText: string): Buffer {
    this.encryptCalls += 1;
    if (this.failEncrypt) throw new Error('keychain locked');
    return Buffer.from(`enc:${plainText}`, 'utf8');
  }

  decryptString(encrypted: Buffer): string {
    this.decryptCalls += 1;
    if (this.failDecrypt) throw new Error('keychain unavailable');
    return encrypted.toString('utf8').replace(/^enc:/, '');
  }
}

const entry = {
  key: 'dalle',
  displayName: 'DALL·E 3',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-secret',
  modelId: 'gpt-image-1',
};

const config = (): MediaProvidersConfig => ({
  [MediaProviderKind.Image]: [{ ...entry }],
  [MediaProviderKind.Video]: [],
});

const asStore = (fake: FakeStore): SqliteStore => fake as unknown as SqliteStore;

describe('mediaProvider store', () => {
  let store: FakeStore;
  let crypto: FakeCrypto;

  beforeEach(() => {
    store = new FakeStore();
    crypto = new FakeCrypto();
    setMediaProviderCrypto(crypto);
  });

  test('round-trips a config through the store', () => {
    writeMediaProvidersConfig(asStore(store), config());
    expect(readMediaProvidersConfig(asStore(store))).toEqual({
      [MediaProviderKind.Image]: [{ ...entry, apiKeyStored: true }],
      [MediaProviderKind.Video]: [],
    });
  });

  test('never hands the plaintext key to the renderer', () => {
    writeMediaProvidersConfig(asStore(store), config());

    const forRenderer = toRendererMediaProvidersConfig(readMediaProvidersConfig(asStore(store)));
    expect(forRenderer.image[0].apiKey).toBe('');
    expect(forRenderer.image[0].apiKeyStored).toBe(true);
    expect(JSON.stringify(forRenderer)).not.toContain('sk-secret');
  });

  test('reports no stored key for an entry that never had one', () => {
    writeMediaProvidersConfig(asStore(store), {
      [MediaProviderKind.Image]: [{ ...entry, apiKey: '' }],
      [MediaProviderKind.Video]: [],
    });
    const forRenderer = toRendererMediaProvidersConfig(readMediaProvidersConfig(asStore(store)));
    expect(forRenderer.image[0].apiKeyStored).toBeUndefined();
  });

  test('clearApiKey removes the stored key instead of keeping it', () => {
    writeMediaProvidersConfig(asStore(store), config());
    const read = readMediaProvidersConfig(asStore(store));

    const merged = mergeMediaProviderApiKeys(asStore(store), {
      ...read,
      [MediaProviderKind.Image]: [{ ...read.image[0], clearApiKey: true }],
    });
    writeMediaProvidersConfig(asStore(store), merged);

    expect(readMediaProvidersConfig(asStore(store)).image[0].apiKey).toBe('');
    const stored = store.raw<{ image: Record<string, unknown>[] }>(MEDIA_PROVIDERS_STORE_KEY);
    expect(stored!.image[0].encryptedApiKey).toBe('');
  });

  test('clearApiKey is not persisted as a field', () => {
    writeMediaProvidersConfig(asStore(store), config());
    const read = readMediaProvidersConfig(asStore(store));

    const merged = mergeMediaProviderApiKeys(asStore(store), {
      ...read,
      [MediaProviderKind.Image]: [{ ...read.image[0], clearApiKey: true }],
    });
    writeMediaProvidersConfig(asStore(store), merged);

    const stored = store.raw<{ image: Record<string, unknown>[] }>(MEDIA_PROVIDERS_STORE_KEY);
    expect(stored!.image[0]).not.toHaveProperty('clearApiKey');
    expect(stored!.image[0]).not.toHaveProperty('apiKeyStored');
  });

  test('encrypts the API key before writing and never stores it in plaintext', () => {
    writeMediaProvidersConfig(asStore(store), config());

    const stored = store.raw<{ image: { encryptedApiKey: string }[] }>(MEDIA_PROVIDERS_STORE_KEY);
    expect(JSON.stringify(stored)).not.toContain('sk-secret');
    // The ciphertext is persisted as base64, so only the decoded form matches.
    const decoded = Buffer.from(stored!.image[0].encryptedApiKey, 'base64').toString('utf8');
    expect(decoded).toBe('enc:sk-secret');
    expect(crypto.encryptCalls).toBe(1);
  });

  test('decrypts the API key on read', () => {
    writeMediaProvidersConfig(asStore(store), config());
    expect(readMediaProvidersConfig(asStore(store)).image[0].apiKey).toBe('sk-secret');
    expect(crypto.decryptCalls).toBe(1);
  });

  test('stores the key empty when OS encryption is unavailable', () => {
    crypto.available = false;
    writeMediaProvidersConfig(asStore(store), config());

    const raw = JSON.stringify(store.raw(MEDIA_PROVIDERS_STORE_KEY));
    expect(raw).not.toContain('sk-secret');
    // The adapter reports a user-visible "no API key" error, which is strictly
    // better than leaking the secret to disk.
    expect(readMediaProvidersConfig(asStore(store)).image[0].apiKey).toBe('');
  });

  test('degrades to an empty key when decryption fails', () => {
    writeMediaProvidersConfig(asStore(store), config());
    crypto.failDecrypt = true;
    expect(readMediaProvidersConfig(asStore(store)).image[0].apiKey).toBe('');
  });

  test('never writes plaintext when encryption throws', () => {
    crypto.failEncrypt = true;
    writeMediaProvidersConfig(asStore(store), config());

    const raw = JSON.stringify(store.raw(MEDIA_PROVIDERS_STORE_KEY));
    expect(raw).not.toContain('sk-secret');
    expect(readMediaProvidersConfig(asStore(store)).image[0].apiKey).toBe('');
  });

  test('falls back to an empty config when nothing is stored', () => {
    expect(readMediaProvidersConfig(asStore(store))).toEqual({
      [MediaProviderKind.Image]: [],
      [MediaProviderKind.Video]: [],
    });
  });

  test('tolerates a malformed or partial stored payload', () => {
    store.set(MEDIA_PROVIDERS_STORE_KEY, 'not-an-object');
    expect(readMediaProvidersConfig(asStore(store)).image).toEqual([]);

    store.set(MEDIA_PROVIDERS_STORE_KEY, { image: 'nope', video: [null, 42] });
    const config = readMediaProvidersConfig(asStore(store));
    expect(config.image).toEqual([]);
    expect(config.video).toEqual([]);
  });

  test('drops duplicate keys on read, keeping the first', () => {
    store.set(MEDIA_PROVIDERS_STORE_KEY, {
      image: [
        { ...entry, displayName: 'first' },
        { ...entry, displayName: 'second' },
      ],
      video: [],
    });
    const entries = readMediaProvidersConfig(asStore(store)).image;
    expect(entries).toHaveLength(1);
    expect(entries[0].displayName).toBe('first');
  });

  test('degrades to an empty config when the store read fails', () => {
    const throwing = {
      get: () => { throw new Error('db closed'); },
      set: () => { throw new Error('db closed'); },
    } as unknown as SqliteStore;

    // A broken read must degrade to "no models" rather than break the caller.
    expect(readMediaProvidersConfig(throwing).image).toEqual([]);
    // A broken write must surface: the settings page has to tell the user the
    // config was not saved.
    expect(() => writeMediaProvidersConfig(throwing, config())).toThrow('db closed');
  });

  test('listMediaEntries and findMediaEntry go through the same decryption', () => {
    writeMediaProvidersConfig(asStore(store), config());

    expect(listMediaEntries(asStore(store), MediaProviderKind.Image)[0].apiKey).toBe('sk-secret');
    expect(findMediaEntry(asStore(store), MediaProviderKind.Image, 'gpt-image-1')?.key).toBe('dalle');
    // Resolves by user-facing key as well as by model id.
    expect(findMediaEntry(asStore(store), MediaProviderKind.Image, 'dalle')?.modelId).toBe('gpt-image-1');
  });

  test('findMediaEntry returns undefined for blank or unknown ids', () => {
    writeMediaProvidersConfig(asStore(store), config());
    expect(findMediaEntry(asStore(store), MediaProviderKind.Image, '   ')).toBeUndefined();
    expect(findMediaEntry(asStore(store), MediaProviderKind.Image, 'nope')).toBeUndefined();
    expect(findMediaEntry(asStore(store), MediaProviderKind.Video, 'dalle')).toBeUndefined();
  });

  test('keeps the stored ciphertext when the key cannot be decrypted', () => {
    writeMediaProvidersConfig(asStore(store), config());
    const ciphertextBefore = store.raw<{ image: { encryptedApiKey: string }[] }>(
      MEDIA_PROVIDERS_STORE_KEY,
    )!.image[0].encryptedApiKey;

    crypto.failDecrypt = true;
    const read = readMediaProvidersConfig(asStore(store));
    expect(read.image[0].apiKey).toBe('');
    expect(read.image[0].apiKeyIssue).toBe('undecryptable');

    // Saving an unrelated edit must not destroy the key: the ciphertext is
    // carried over verbatim and comes back once decryption works again.
    const merged = mergeMediaProviderApiKeys(asStore(store), {
      ...read,
      [MediaProviderKind.Image]: [{ ...read.image[0], displayName: 'renamed' }],
    });
    writeMediaProvidersConfig(asStore(store), merged);

    const ciphertextAfter = store.raw<{ image: { encryptedApiKey: string }[] }>(
      MEDIA_PROVIDERS_STORE_KEY,
    )!.image[0].encryptedApiKey;
    expect(ciphertextAfter).toBe(ciphertextBefore);

    crypto.failDecrypt = false;
    const reread = readMediaProvidersConfig(asStore(store));
    expect(reread.image[0].apiKey).toBe('sk-secret');
    expect(reread.image[0].displayName).toBe('renamed');
  });

  test('keeps the stored ciphertext when encryption is unavailable at save time', () => {
    writeMediaProvidersConfig(asStore(store), config());
    const ciphertextBefore = store.raw<{ image: { encryptedApiKey: string }[] }>(
      MEDIA_PROVIDERS_STORE_KEY,
    )!.image[0].encryptedApiKey;

    // Read path cannot decrypt, so the renderer sees an empty key.
    crypto.available = false;
    const read = readMediaProvidersConfig(asStore(store));
    expect(read.image[0].apiKey).toBe('');
    expect(read.image[0].apiKeyIssue).toBe('encryption-unavailable');

    const merged = mergeMediaProviderApiKeys(asStore(store), read);
    writeMediaProvidersConfig(asStore(store), merged);

    // Encryption coming back must restore the original secret.
    crypto.available = true;
    expect(readMediaProvidersConfig(asStore(store)).image[0].apiKey).toBe('sk-secret');
    expect(
      store.raw<{ image: { encryptedApiKey: string }[] }>(MEDIA_PROVIDERS_STORE_KEY)!.image[0]
        .encryptedApiKey,
    ).toBe(ciphertextBefore);
  });

  test('mergeMediaProviderApiKeys prefers a newly typed key over the stored one', () => {
    writeMediaProvidersConfig(asStore(store), config());
    const read = readMediaProvidersConfig(asStore(store));

    const merged = mergeMediaProviderApiKeys(asStore(store), {
      ...read,
      [MediaProviderKind.Image]: [{ ...read.image[0], apiKey: 'sk-rotated' }],
    });
    writeMediaProvidersConfig(asStore(store), merged);

    expect(readMediaProvidersConfig(asStore(store)).image[0].apiKey).toBe('sk-rotated');
  });

  test('mergeMediaProviderApiKeys matches the stored key by modelId after a key rename', () => {
    writeMediaProvidersConfig(asStore(store), config());
    const read = readMediaProvidersConfig(asStore(store));

    const merged = mergeMediaProviderApiKeys(asStore(store), {
      ...read,
      [MediaProviderKind.Image]: [{ ...read.image[0], key: 'renamed', apiKey: '' }],
    });
    writeMediaProvidersConfig(asStore(store), merged);

    expect(readMediaProvidersConfig(asStore(store)).image[0].apiKey).toBe('sk-secret');
  });

  test('mergeMediaProviderApiKeys leaves an entry without a stored key untouched', () => {
    const incoming = { ...config(), [MediaProviderKind.Image]: [{ ...entry, apiKey: '' }] };
    const merged = mergeMediaProviderApiKeys(asStore(store), incoming);
    expect(merged.image[0].apiKey).toBe('');
    expect(merged.image[0].preservedCiphertext).toBeUndefined();
  });

  test('never exposes preservedCiphertext through the shared normalizer', () => {
    // The field is main-process only; a renderer round-trip must strip it.
    const normalized = normalizeMediaProvidersConfig({
      [MediaProviderKind.Image]: [{ ...entry, preservedCiphertext: 'cipher', apiKeyIssue: 'undecryptable' }],
      [MediaProviderKind.Video]: [],
    });
    expect(normalized?.image[0]).not.toHaveProperty('preservedCiphertext');
    expect(normalized?.image[0]).not.toHaveProperty('apiKeyIssue');
  });

  test('lazily re-encrypts a legacy plaintext key on read', () => {
    store.set(MEDIA_PROVIDERS_STORE_KEY, { image: [{ ...entry }], video: [] });

    // The read itself returns the plaintext key unchanged...
    expect(readMediaProvidersConfig(asStore(store)).image[0].apiKey).toBe('sk-secret');
    // ...and rewrites it in encrypted form as a side effect.
    const stored = store.raw<{ image: Record<string, unknown>[] }>(MEDIA_PROVIDERS_STORE_KEY);
    expect(stored!.image[0]).toHaveProperty('encryptedApiKey');
    expect(JSON.stringify(stored)).not.toContain('sk-secret');
  });

  test('keeps a legacy plaintext key when encryption is unavailable', () => {
    store.set(MEDIA_PROVIDERS_STORE_KEY, { image: [{ ...entry }], video: [] });
    crypto.available = false;

    expect(readMediaProvidersConfig(asStore(store)).image[0].apiKey).toBe('sk-secret');
    // Migrating here would destroy the key, so it must stay plaintext.
    const stored = store.raw<{ image: Record<string, unknown>[] }>(MEDIA_PROVIDERS_STORE_KEY);
    expect(stored!.image[0]).not.toHaveProperty('encryptedApiKey');
    expect(stored!.image[0].apiKey).toBe('sk-secret');
  });

  test('reads legacy plaintext entries without blanking the key', () => {
    // Config written before API keys were encrypted: plaintext `apiKey`,
    // no `encryptedApiKey`.
    store.set(MEDIA_PROVIDERS_STORE_KEY, {
      image: [{ ...entry }],
      video: [],
    });
    expect(readMediaProvidersConfig(asStore(store)).image[0].apiKey).toBe('sk-secret');
  });

  test('re-encrypts a legacy plaintext entry on the next write', () => {
    store.set(MEDIA_PROVIDERS_STORE_KEY, { image: [{ ...entry }], video: [] });
    const read = readMediaProvidersConfig(asStore(store));
    writeMediaProvidersConfig(asStore(store), read);

    const stored = store.raw<{ image: Record<string, unknown>[] }>(MEDIA_PROVIDERS_STORE_KEY);
    expect(JSON.stringify(stored)).not.toContain('sk-secret');
    expect(stored!.image[0]).toHaveProperty('encryptedApiKey');
  });

  test('falls back to the module-level crypto registered at startup', () => {
    // No explicit crypto argument: the startup registration must be picked up.
    writeMediaProvidersConfig(asStore(store), config());
    expect(readMediaProvidersConfig(asStore(store)).image[0].apiKey).toBe('sk-secret');

    setMediaProviderCrypto(undefined);
    writeMediaProvidersConfig(asStore(store), config());
    expect(readMediaProvidersConfig(asStore(store)).image[0].apiKey).toBe('');
  });
});
