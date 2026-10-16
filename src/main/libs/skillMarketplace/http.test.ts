import { beforeEach, describe, expect, test, vi } from 'vitest';

const fetchMock = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  session: { defaultSession: { fetch: fetchMock } },
}));

import { fetchJson, resolveAgainst } from './http';
import { MarketplaceError } from './types';

function jsonResponse(status: number, body: unknown = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe('fetchJson', () => {
  test('parses a 2xx JSON body', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { value: 42 }));
    await expect(fetchJson<{ value: number }>('https://a.test/x')).resolves.toEqual({ value: 42 });
  });

  test('sends Accept and custom headers (e.g. User-Agent)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200));
    await fetchJson('https://a.test/x', { headers: { 'User-Agent': 'HiAi/1.0' } });
    const init = fetchMock.mock.calls[0][1];
    expect(init.method).toBe('GET');
    expect(init.headers).toEqual({ Accept: 'application/json', 'User-Agent': 'HiAi/1.0' });
  });

  test('throws MarketplaceError with the status on non-2xx', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(500));
    const error = await fetchJson('https://a.test/x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MarketplaceError);
    expect((error as MarketplaceError).message).toContain('HTTP 500');
  });

  test('applies the default 15s timeout via AbortController', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            const abortError = new Error('aborted');
            abortError.name = 'AbortError';
            reject(abortError);
          });
        }),
    );
    try {
      const pending = fetchJson('https://a.test/slow');
      const assertion = expect(pending).rejects.toThrow(MarketplaceError);
      await vi.advanceTimersByTimeAsync(14_999);
      expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  test('honours a custom timeoutMs', async () => {
    vi.useFakeTimers();
    let aborted = false;
    fetchMock.mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            aborted = true;
            const abortError = new Error('aborted');
            abortError.name = 'AbortError';
            reject(abortError);
          });
        }),
    );
    try {
      const pending = fetchJson('https://a.test/slow', { timeoutMs: 2_000 });
      const assertion = expect(pending).rejects.toThrow(MarketplaceError);
      await vi.advanceTimersByTimeAsync(2_000);
      await assertion;
      expect(aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test('clears the timer after success', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    try {
      await expect(fetchJson('https://a.test/x')).resolves.toEqual({ ok: true });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test('wraps network failures in MarketplaceError', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const error = await fetchJson('https://a.test/x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MarketplaceError);
    expect((error as MarketplaceError).message).toContain('ECONNREFUSED');
  });
});

describe('resolveAgainst', () => {
  const origin = 'https://api.example.test';

  test('keeps absolute http(s) URLs untouched', () => {
    expect(resolveAgainst(origin, 'https://cdn.test/i.png')).toBe('https://cdn.test/i.png');
    expect(resolveAgainst(origin, 'http://cdn.test/i.png')).toBe('http://cdn.test/i.png');
  });

  test('resolves relative paths against the origin', () => {
    expect(resolveAgainst(origin, '/icons/a.png')).toBe('https://api.example.test/icons/a.png');
    expect(resolveAgainst(origin, 'icons/a.png')).toBe('https://api.example.test/icons/a.png');
  });

  test('returns undefined for empty or missing values', () => {
    expect(resolveAgainst(origin, undefined)).toBeUndefined();
    expect(resolveAgainst(origin, null)).toBeUndefined();
    expect(resolveAgainst(origin, '')).toBeUndefined();
    expect(resolveAgainst(origin, '   ')).toBeUndefined();
  });

  test('returns undefined when the raw value is not a valid path', () => {
    expect(resolveAgainst('not a url', 'a b c')).toBeUndefined();
  });
});
