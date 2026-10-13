import { describe, expect, test, vi } from 'vitest';

import type { SqliteStore } from '../../sqliteStore';
import { createMiniMaxVideoAdapter } from './minimaxVideo';
import {
  EMPTY_MEDIA_PROVIDERS_CONFIG,
  MEDIA_PROVIDERS_STORE_KEY,
  type MediaProvidersConfig,
} from './store';
import { MEDIA_TASK_TARGETS_STORE_KEY, resolveMediaTaskTarget } from './taskRegistry';
import { MediaProviderError, MediaProviderKind, MediaTaskStatus } from './types';

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

const videoConfig = (): MediaProvidersConfig => ({
  ...EMPTY_MEDIA_PROVIDERS_CONFIG,
  video: [{
    key: 'minimax',
    displayName: 'MiniMax Video',
    baseUrl: 'https://api.minimax.cn/v1',
    apiKey: 'mm-key',
    modelId: 'MiniMax-Hailuo-2.3',
  }],
});

const jsonResponse = (body: unknown, status = 200): Response => (
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
);

describe('MiniMax video adapter', () => {
  test('reports the video kind and lists configured models', () => {
    const adapter = createMiniMaxVideoAdapter({ store: createFakeStore(videoConfig()) });
    expect(adapter.kind).toBe(MediaProviderKind.Video);
    expect(adapter.resolver.listModels()).toHaveLength(1);
    expect(adapter.resolver.resolveTarget('minimax')?.modelId).toBe('MiniMax-Hailuo-2.3');
    expect(adapter.resolver.canServe('nope')).toBe(false);
  });

  test('creates a task, maps durationSeconds to duration, and records the target', async () => {
    const store = createFakeStore(videoConfig());
    const fetchImpl = vi.fn(async () => jsonResponse({
      task_id: 'task-1',
      base_resp: { status_code: 0 },
    }));
    const adapter = createMiniMaxVideoAdapter({
      store,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const target = adapter.resolver.resolveTarget('MiniMax-Hailuo-2.3')!;

    const result = await adapter.generate({
      target,
      prompt: 'a flying cat',
      params: { durationSeconds: 6, resolution: '1080P', ignored: 'x' },
    });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.minimax.cn/v1/video_generation');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer mm-key');
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'MiniMax-Hailuo-2.3',
      prompt: 'a flying cat',
      duration: 6,
      resolution: '1080P',
    });

    expect(result.status).toBe(MediaTaskStatus.Queued);
    expect(result.taskId).toBe('task-1');
    // main.ts needs the target back later to poll this task.
    expect(resolveMediaTaskTarget(store, 'task-1')?.providerKey).toBe('minimax');
  });

  test('treats a non-zero base_resp as an error even on HTTP 200', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      base_resp: { status_code: 1004, status_msg: 'auth failed' },
    }));
    const adapter = createMiniMaxVideoAdapter({
      store: createFakeStore(videoConfig()),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const target = adapter.resolver.resolveTarget('minimax')!;

    await expect(adapter.generate({ target, prompt: 'x', params: {} }))
      .rejects.toBeInstanceOf(MediaProviderError);
  });

  test('maps status keywords to normalised task states', async () => {
    const states: Array<[string, string]> = [
      ['Preparing', MediaTaskStatus.Queued],
      ['Queueing', MediaTaskStatus.Queued],
      ['Processing', MediaTaskStatus.Running],
      ['Fail', MediaTaskStatus.Failed],
    ];

    for (const [upstream, expected] of states) {
      const fetchImpl = vi.fn(async () => jsonResponse({
        status: upstream,
        base_resp: { status_code: 0 },
      }));
      const adapter = createMiniMaxVideoAdapter({
        store: createFakeStore(videoConfig()),
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      const target = adapter.resolver.resolveTarget('minimax')!;
      const result = await adapter.status('task-1', target);
      expect(result.status).toBe(expected);
    }
  });

  test('resolves the download URL on success via a second request', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes('/query/video_generation')) {
        return jsonResponse({ status: 'Success', file_id: 'file-1', base_resp: { status_code: 0 } });
      }
      return jsonResponse({
        file: { download_url: 'https://cdn.minimax.cn/v.mp4' },
        base_resp: { status_code: 0 },
      });
    });
    const adapter = createMiniMaxVideoAdapter({
      store: createFakeStore(videoConfig()),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const target = adapter.resolver.resolveTarget('minimax')!;

    const result = await adapter.status('task-1', target);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[1][0])).toContain('/files/retrieve?file_id=file-1');
    expect(result.status).toBe(MediaTaskStatus.Succeeded);
    expect(result.resultUrls).toEqual(['https://cdn.minimax.cn/v.mp4']);
  });

  test('reports failure when success carries no file_id', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      status: 'Success',
      base_resp: { status_code: 0 },
    }));
    const adapter = createMiniMaxVideoAdapter({
      store: createFakeStore(videoConfig()),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const target = adapter.resolver.resolveTarget('minimax')!;

    const result = await adapter.status('task-1', target);
    expect(result.status).toBe(MediaTaskStatus.Failed);
    expect(result.errorMessage).toBeTruthy();
  });

  test('cancel drops local tracking since MiniMax has no cancel endpoint', async () => {
    const store = createFakeStore(videoConfig());
    const fetchImpl = vi.fn(async () => jsonResponse({
      task_id: 'task-9',
      base_resp: { status_code: 0 },
    }));
    const adapter = createMiniMaxVideoAdapter({
      store,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const target = adapter.resolver.resolveTarget('minimax')!;
    await adapter.generate({ target, prompt: 'x', params: {} });
    expect(resolveMediaTaskTarget(store, 'task-9')).toBeDefined();

    const cancelled = await adapter.cancel!('task-9', target);
    expect(cancelled.cancelled).toBe(true);
    expect(resolveMediaTaskTarget(store, 'task-9')).toBeUndefined();
  });

  test('prunes stale task targets past the TTL', () => {
    const store = createFakeStore();
    store.set(MEDIA_TASK_TARGETS_STORE_KEY, {
      old: {
        providerKey: 'minimax',
        baseUrl: 'https://api.minimax.cn/v1',
        apiKey: 'k',
        modelId: 'm',
        displayName: 'm',
        createdAt: Date.now() - 25 * 60 * 60 * 1000,
      },
    });
    expect(resolveMediaTaskTarget(store, 'old')).toBeUndefined();
  });
});
