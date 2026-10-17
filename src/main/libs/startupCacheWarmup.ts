import {
  LOBSTERAI_CLIENT_CAPABILITIES,
  LOBSTERAI_CLIENT_CAPABILITIES_HEADER,
  LOBSTERAI_CLIENT_VERSION_HEADER,
} from '../../shared/providers/modelRuntimeProfiles';
import {
  type ServerModelMetadataInput,
  updateServerModelMetadata,
} from './claudeSettings';

export type ServerModelEntry = ServerModelMetadataInput;

export type StartupCacheWarmupDeps = {
  serverBaseUrl: string;
  fetchWithAuth: (url: string, options?: RequestInit) => Promise<Response>;
  appendKeyfromQuery: (url: string) => string;
  clientVersion: string;
  /** Offline guard; when it reports false the request is skipped entirely. */
  isOnline?: () => boolean;
};

export type StartupCacheWarmupResult = Record<string, never>;

const WARMUP_TIMEOUT = 5000;

export const buildServerModelCapabilityHeaders = (
  clientVersion: string,
): Record<string, string> => ({
  Accept: 'application/json',
  [LOBSTERAI_CLIENT_CAPABILITIES_HEADER]: LOBSTERAI_CLIENT_CAPABILITIES,
  [LOBSTERAI_CLIENT_VERSION_HEADER]: clientVersion,
});

/**
 * Pre-warm the server model metadata cache so provider resolution sees real
 * server data instead of empty defaults.
 */
export async function runStartupCacheWarmup(deps: StartupCacheWarmupDeps): Promise<StartupCacheWarmupResult> {
  const {
    serverBaseUrl,
    fetchWithAuth,
    appendKeyfromQuery,
    clientVersion,
    isOnline,
  } = deps;

  if (isOnline && !isOnline()) {
    console.debug('[Main] startup cache warmup: offline, skipping server model request');
    return {};
  }

  try {
    const url = appendKeyfromQuery(`${serverBaseUrl}/api/models/available`);
    const resp = await fetchWithAuth(url, {
      headers: buildServerModelCapabilityHeaders(clientVersion),
      signal: AbortSignal.timeout(WARMUP_TIMEOUT),
    });
    if (resp.ok) {
      const data = (await resp.json()) as { code: number; data: ServerModelEntry[] };
      if (data.code === 0 && data.data) {
        updateServerModelMetadata(data.data);
        console.log(`[Main] startup cache warmup: loaded ${data.data.length} server models`);
      }
    }
  } catch (err) {
    console.debug('[Main] startup cache warmup: models fetch failed (non-fatal):', err);
  }

  return {};
}
