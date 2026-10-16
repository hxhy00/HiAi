import { session } from 'electron';

import { MarketplaceError } from './types';

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * GET a JSON document through Electron's session (shares cookies/proxy config
 * with the rest of the app). Throws `MarketplaceError` on non-2xx responses.
 */
export async function fetchJson<T>(
  url: string,
  init: { timeoutMs?: number; headers?: Record<string, string> } = {},
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    init.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  try {
    const response = await session.defaultSession.fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...init.headers,
      },
    });
    if (!response.ok) {
      throw new MarketplaceError(`HTTP ${response.status} for ${url}`, response.status);
    }
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof MarketplaceError) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new MarketplaceError(`Request failed for ${url}: ${reason}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Resolve a possibly-relative icon/URL against a source origin. */
export function resolveAgainst(origin: string, value: string | undefined | null): string | undefined {
  const raw = (value ?? '').trim();
  if (!raw) return undefined;
  if (/^https?:\/\//i.test(raw)) return raw;
  try {
    return new URL(raw, origin).toString();
  } catch {
    return undefined;
  }
}
