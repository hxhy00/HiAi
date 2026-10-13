import { describe, expect, test, vi } from 'vitest';

import type { SqliteStore } from '../../sqliteStore';
import { createOpenAIImageAdapter } from './openaiCompatImage';
import {
  EMPTY_MEDIA_PROVIDERS_CONFIG,
  MEDIA_PROVIDERS_STORE_KEY,
  type MediaProvidersConfig,
  readMediaProvidersConfig,
  writeMediaProvidersConfig,
} from './store';
import { MediaProviderError, MediaProviderKind } from './types';

/** In-memory SqliteStore stand-in covering only get/set. */
const createFakeStore = (initial?: MediaProvidersConfig): SqliteStore => {
  const values = new Map<string, unknown>();
  if (initial) values.set(MEDIA_PROVIDERS_STORE_KEY, initial);
  return {
    get: (key: string) => values.get(key),
    set: (key: string, value: unknown) => {
      values.set(key, value);
    },
  } as unknown as SqliteStore;
};

const imageConfig = (): MediaProvidersConfig => ({
  ...EMPTY_MEDIA_PROVIDERS_CONFIG,
  image: [{
    key: 'local-openai',
    displayName: 'Local OpenAI Image',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-test',
    modelId: 'gpt-image-2',
  }],
});

const jsonResponse = (body: unknown, status = 200): Response => (
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
);

describe('media provider store', () => {
  test('missing config degrades to empty lists', () => {
    expect(readMediaProvidersConfig(createFakeStore())).toEqual(EMPTY_MEDIA_PROVIDERS_CONFIG);
  });

  test('malformed entries are dropped, duplicates by key collapse', () => {
    const store = createFakeStore();
    store.set(MEDIA_PROVIDERS_STORE_KEY, {
      image: [
        { key: 'a', modelId: 'gpt-image-2', baseUrl: 'https://x.test/v1', apiKey: 'k' },
        { key: 'a', modelId: 'dup', baseUrl: 'https://x.test/v1', apiKey: 'k' },
        { modelId: '' },
        'not-an-entry',
      ],
    });

    const config = readMediaProvidersConfig(store);
    expect(config.image).toHaveLength(1);
    expect(config.image[0].key).toBe('a');
    expect(config.video).toEqual([]);
  });

  test('round-trips through write/read', () => {
    const store = createFakeStore();
    writeMediaProvidersConfig(store, imageConfig());
    expect(readMediaProvidersConfig(store).image[0].modelId).toBe('gpt-image-2');
  });
});

describe('openai-compatible image adapter', () => {
  test('lists configured models and resolves targets by key or modelId', () => {
    const adapter = createOpenAIImageAdapter({ store: createFakeStore(imageConfig()) });
    const models = adapter.resolver.listModels();

    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ modelId: 'gpt-image-2', displayName: 'Local OpenAI Image' });
    expect(adapter.resolver.resolveTarget('local-openai')?.modelId).toBe('gpt-image-2');
    expect(adapter.resolver.resolveTarget('gpt-image-2')?.modelId).toBe('gpt-image-2');
    expect(adapter.resolver.canServe('unknown-model')).toBe(false);
  });

  test('posts to images/generations and maps the response to results', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      created: 1,
      data: [{ url: 'https://cdn.test/out.png' }],
    }));
    const adapter = createOpenAIImageAdapter({
      store: createFakeStore(imageConfig()),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const target = adapter.resolver.resolveTarget('gpt-image-2')!;

    const result = await adapter.generate({ target, prompt: 'a cat', params: { size: '1024x1024', n: 1 } });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/images/generations');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
    expect(JSON.parse(init.body as string)).toMatchObject({
      model: 'gpt-image-2',
      prompt: 'a cat',
      size: '1024x1024',
      n: 1,
    });

    expect(result.status).toBe('succeeded');
    expect(result.resultUrls).toEqual(['https://cdn.test/out.png']);
    expect(result.model).toBe('gpt-image-2');
  });

  test('uses the edits endpoint when reference images are present', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [{ b64_json: 'AAAA' }] }));
    const adapter = createOpenAIImageAdapter({
      store: createFakeStore(imageConfig()),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const target = adapter.resolver.resolveTarget('gpt-image-2')!;

    const result = await adapter.generate({
      target,
      prompt: 'restyle',
      params: { images: ['data:image/png;base64,AAAA'] },
    });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/images/edits');
    expect(JSON.parse(init.body as string).image).toBe('data:image/png;base64,AAAA');
    expect(result.resultUrls).toEqual(['data:image/png;base64,AAAA']);
  });

  test('surfaces upstream errors as MediaProviderError', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { message: 'bad key' } }, 401));
    const adapter = createOpenAIImageAdapter({
      store: createFakeStore(imageConfig()),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const target = adapter.resolver.resolveTarget('gpt-image-2')!;

    await expect(adapter.generate({ target, prompt: 'x', params: {} }))
      .rejects.toBeInstanceOf(MediaProviderError);
  });

  test('rejects a target without an API key', async () => {
    const adapter = createOpenAIImageAdapter({ store: createFakeStore() });
    await expect(adapter.generate({
      target: { providerKey: 'x', baseUrl: 'https://x.test/v1', apiKey: '', modelId: 'm', displayName: 'm' },
      prompt: 'x',
      params: {},
    })).rejects.toBeInstanceOf(MediaProviderError);
  });

  test('reports the image kind', () => {
    const adapter = createOpenAIImageAdapter({ store: createFakeStore() });
    expect(adapter.kind).toBe(MediaProviderKind.Image);
  });
});
