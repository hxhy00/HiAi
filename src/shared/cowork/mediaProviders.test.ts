import { describe, expect, test } from 'vitest';

import {
  EMPTY_MEDIA_PROVIDERS_CONFIG,
  MediaProviderKind,
  normalizeMediaProviderEntry,
  normalizeMediaProvidersConfig,
} from './mediaProviders';

/** Minimal well-formed entry used as the base for the negative cases. */
const validEntry = {
  key: 'dalle',
  displayName: 'DALL·E 3',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-secret',
  modelId: 'gpt-image-1',
};

describe('normalizeMediaProviderEntry', () => {
  test('keeps a well-formed entry intact', () => {
    expect(normalizeMediaProviderEntry(validEntry)).toEqual(validEntry);
  });

  test('rejects non-objects', () => {
    for (const value of [null, undefined, 'text', 42, [], true]) {
      expect(normalizeMediaProviderEntry(value)).toBeUndefined();
    }
  });

  test('drops an entry without a modelId', () => {
    expect(normalizeMediaProviderEntry({ ...validEntry, modelId: '   ' })).toBeUndefined();
    const { modelId: _modelId, ...withoutModelId } = validEntry;
    expect(normalizeMediaProviderEntry(withoutModelId)).toBeUndefined();
  });

  test('trims every string field', () => {
    const entry = normalizeMediaProviderEntry({
      key: '  dalle  ',
      displayName: '  DALL·E 3  ',
      baseUrl: '  https://api.openai.com/v1  ',
      apiKey: '  sk-secret  ',
      modelId: '  gpt-image-1  ',
      capabilities: '  reference images  ',
    });
    expect(entry).toEqual({
      key: 'dalle',
      displayName: 'DALL·E 3',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-secret',
      modelId: 'gpt-image-1',
      capabilities: 'reference images',
    });
  });

  test('falls back to modelId for a blank key and displayName', () => {
    const entry = normalizeMediaProviderEntry({
      ...validEntry,
      key: '',
      displayName: '',
    });
    expect(entry?.key).toBe('gpt-image-1');
    expect(entry?.displayName).toBe('gpt-image-1');
  });

  test('omits blank capabilities rather than storing an empty string', () => {
    expect(normalizeMediaProviderEntry({ ...validEntry, capabilities: '   ' }))
      .not.toHaveProperty('capabilities');
  });

  test('allows a blank baseUrl so a half-filled row can be saved', () => {
    expect(normalizeMediaProviderEntry({ ...validEntry, baseUrl: '' })?.baseUrl).toBe('');
  });

  test('preserves the apiKeyStored hint but drops a forged `false`', () => {
    expect(normalizeMediaProviderEntry({ ...validEntry, apiKeyStored: true })?.apiKeyStored).toBe(true);
    expect(normalizeMediaProviderEntry({ ...validEntry, apiKeyStored: false }))
      .not.toHaveProperty('apiKeyStored');
  });

  test('preserves the clearApiKey intent but drops a forged `false`', () => {
    expect(normalizeMediaProviderEntry({ ...validEntry, clearApiKey: true })?.clearApiKey).toBe(true);
    expect(normalizeMediaProviderEntry({ ...validEntry, clearApiKey: false }))
      .not.toHaveProperty('clearApiKey');
  });

  test('never lets main-process-only fields through', () => {
    const entry = normalizeMediaProviderEntry({
      ...validEntry,
      preservedCiphertext: 'cipher',
      apiKeyIssue: 'undecryptable',
    });
    expect(entry).not.toHaveProperty('preservedCiphertext');
    expect(entry).not.toHaveProperty('apiKeyIssue');
  });

  test('rejects non-http(s) endpoints before they reach fetch', () => {
    for (const baseUrl of ['file:///etc/passwd', 'javascript:alert(1)', 'ftp://host', 'not a url']) {
      expect(normalizeMediaProviderEntry({ ...validEntry, baseUrl })).toBeUndefined();
    }
  });

  test('accepts http as well as https', () => {
    expect(normalizeMediaProviderEntry({ ...validEntry, baseUrl: 'http://localhost:8000/v1' }))
      .toBeDefined();
  });
});

describe('normalizeMediaProvidersConfig', () => {
  test('returns undefined for a payload that is not a plain object', () => {
    for (const value of [null, undefined, 'text', 42, [], true]) {
      expect(normalizeMediaProvidersConfig(value)).toBeUndefined();
    }
  });

  test('always yields both kinds, even when the input omits them', () => {
    const config = normalizeMediaProvidersConfig({});
    expect(config).toEqual(EMPTY_MEDIA_PROVIDERS_CONFIG);
    expect(config).not.toBe(EMPTY_MEDIA_PROVIDERS_CONFIG);
  });

  test('ignores unknown kinds', () => {
    const config = normalizeMediaProvidersConfig({
      audio: [validEntry],
      [MediaProviderKind.Image]: [validEntry],
    });
    expect(Object.keys(config ?? {})).toEqual(['image', 'video']);
    expect(config?.image).toHaveLength(1);
  });

  test('collapses duplicate keys within a kind, keeping the first', () => {
    const config = normalizeMediaProvidersConfig({
      [MediaProviderKind.Image]: [
        { ...validEntry, displayName: 'first' },
        { ...validEntry, displayName: 'second' },
      ],
    });
    expect(config?.image).toHaveLength(1);
    expect(config?.image[0].displayName).toBe('first');
  });

  test('keeps entries that share a key across different kinds', () => {
    const config = normalizeMediaProvidersConfig({
      [MediaProviderKind.Image]: [validEntry],
      [MediaProviderKind.Video]: [validEntry],
    });
    expect(config?.image).toHaveLength(1);
    expect(config?.video).toHaveLength(1);
  });

  test('drops malformed rows without discarding the rest of the list', () => {
    const config = normalizeMediaProvidersConfig({
      [MediaProviderKind.Image]: [
        null,
        { ...validEntry, modelId: '' },
        { ...validEntry, baseUrl: 'javascript:alert(1)' },
        { ...validEntry, key: 'kept', modelId: 'kept-model' },
      ],
    });
    expect(config?.image).toHaveLength(1);
    expect(config?.image[0].key).toBe('kept');
  });

  test('treats a non-array kind as empty instead of throwing', () => {
    const config = normalizeMediaProvidersConfig({
      [MediaProviderKind.Image]: 'nope',
      [MediaProviderKind.Video]: [validEntry],
    });
    expect(config?.image).toEqual([]);
    expect(config?.video).toHaveLength(1);
  });
});
