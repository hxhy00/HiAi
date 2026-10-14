import {
  type ModelThinkingConfig,
  parseLobsterAIRequestCapabilities,
  parseModelThinkingConfig,
  ProviderName,
} from '@shared/providers';
import type { ModelRuntimeProfile } from '@shared/providers/modelRuntimeProfiles';
import { store } from '../store';
import type { Model } from '../store/slices/modelSlice';
import { setServerModels } from '../store/slices/modelSlice';

export interface PricingCatalogBaseModel {
  modelId?: string;
  modelName?: string;
  provider?: string;
  providerLabel?: string;
  description?: string;
  capabilities?: string | null;
}

export interface PricingCatalogTextModel extends PricingCatalogBaseModel {
  supportsImage?: boolean;
  supportsThinking?: boolean;
  thinkingConfig?: ModelThinkingConfig;
  contextWindow?: number | null;
  costMultiplier?: number;
  moreModel?: boolean;
}

export interface PricingCatalogMediaModel extends PricingCatalogBaseModel {
  mediaType?: string;
  billingUnit?: string;
  unitLabel?: string;
  unitCredits?: number;
  unitPriceYuan?: number;
  pricingDescription?: string | null;
}

export interface PricingCatalogResponse {
  textModels?: PricingCatalogTextModel[];
  imageModels?: PricingCatalogMediaModel[];
  videoModels?: PricingCatalogMediaModel[];
}

export interface AvailableServerModelEntry {
  modelId: string;
  modelName: string;
  provider: string;
  apiFormat: string;
  runtimeProfile?: ModelRuntimeProfile;
  supportsImage?: boolean;
  supportsVideo?: boolean;
  supportsThinking?: boolean;
  thinkingConfig?: ModelThinkingConfig;
  requestCapabilities?: unknown;
  supportsToolCalling?: boolean;
  agenticReady?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  explicitContextCache?: boolean;
  costMultiplier?: number;
  description?: string;
  moreModel?: boolean;
  accessible?: boolean;
  restrictionHint?: string;
}

const readString = (value: unknown): string => (
  typeof value === 'string' ? value.trim() : ''
);

const readPositiveNumber = (value: unknown): number | undefined => (
  typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : undefined
);

type AuthRendererLogLevel = 'debug' | 'info' | 'warn';

export interface AuthAccountRequestSnapshot {
  accountGeneration: number;
}

export const isAuthAccountRequestCurrent = (
  expected: AuthAccountRequestSnapshot,
  current: AuthAccountRequestSnapshot,
): boolean => (
  current.accountGeneration === expected.accountGeneration
);

const writeAuthRendererLog = (
  level: AuthRendererLogLevel,
  message: string,
  error?: unknown,
): void => {
  const errorMessage = error === undefined
    ? ''
    : `: ${error instanceof Error ? error.message : String(error)}`;
  const resolvedMessage = `${message}${errorMessage}`.replace(/\s+/g, ' ').trim().slice(0, 500);
  if (level === 'warn') {
    if (error === undefined) {
      console.warn(`[Auth] ${resolvedMessage}`);
    } else {
      console.warn(`[Auth] ${message}:`, error);
    }
  } else if (level === 'debug') {
    console.debug(`[Auth] ${resolvedMessage}`);
  } else {
    console.log(`[Auth] ${resolvedMessage}`);
  }

  try {
    window.electron?.log?.fromRenderer?.(level, 'AuthService', resolvedMessage);
  } catch {
    // Logging is best-effort.
  }
};

export function mapPricingCatalogTextModelsToServerModels(
  textModels: PricingCatalogTextModel[],
): Model[] {
  return textModels.flatMap((model): Model[] => {
    const modelId = readString(model.modelId);
    if (!modelId) return [];

    const modelName = readString(model.modelName) || modelId;
    const provider = readString(model.providerLabel)
      || readString(model.provider)
      || 'LobsterAI';
    const contextWindow = readPositiveNumber(model.contextWindow);
    const costMultiplier = readPositiveNumber(model.costMultiplier);
    const thinkingConfig = model.supportsThinking === true
      ? parseModelThinkingConfig(model.thinkingConfig)
      : undefined;

    return [{
      id: modelId,
      name: modelName,
      provider,
      providerKey: ProviderName.LobsteraiServer,
      isServerModel: true,
      supportsImage: model.supportsImage === true,
      supportsThinking: model.supportsThinking === true,
      thinkingConfig,
      description: readString(model.description) || undefined,
      costMultiplier,
      contextWindow,
      moreModel: model.moreModel === true,
      accessible: false,
    }];
  });
}

export function mapPricingCatalogToPublicServerModels(
  catalog: PricingCatalogResponse,
): Model[] {
  return mapPricingCatalogTextModelsToServerModels(
    Array.isArray(catalog.textModels) ? catalog.textModels : [],
  );
}

export function mapAvailableServerModelsToModels(
  models: AvailableServerModelEntry[],
): Model[] {
  return models.map(model => {
    const thinkingConfig = model.supportsThinking === true
      ? parseModelThinkingConfig(model.thinkingConfig)
      : undefined;
    const requestCapabilities = parseLobsterAIRequestCapabilities(model.requestCapabilities);
    return {
      id: model.modelId,
      name: model.modelName,
      provider: model.provider,
      providerKey: ProviderName.LobsteraiServer,
      isServerModel: true,
      serverApiFormat: model.apiFormat,
      runtimeProfile: model.runtimeProfile,
      supportsImage: model.supportsImage ?? false,
      supportsVideo: model.supportsVideo ?? false,
      supportsThinking: model.supportsThinking ?? false,
      thinkingConfig,
      requestCapabilities,
      supportsToolCalling: model.supportsToolCalling,
      agenticReady: model.agenticReady,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      explicitContextCache: model.explicitContextCache ?? false,
      description: model.description,
      costMultiplier: model.costMultiplier,
      moreModel: model.moreModel === true,
      accessible: model.accessible ?? true,
      restrictionHint: model.restrictionHint ?? undefined,
    };
  });
}

/**
 * Backoff between server model load attempts. A single transient failure
 * (offline at launch, server blip) must not leave the plan model group empty
 * until the next app launch.
 */
const SERVER_MODEL_LOAD_RETRY_DELAYS_MS = [1_000, 3_000, 8_000] as const;

const ServerModelLoadOutcome = {
  Loaded: 'loaded',
  Retryable: 'retryable',
  Abandoned: 'abandoned',
} as const;
type ServerModelLoadOutcome = typeof ServerModelLoadOutcome[keyof typeof ServerModelLoadOutcome];

/**
 * Server model catalog service.
 *
 * Login capability was removed (remove-membership §11 D1): there is no
 * authenticated account state, so the only remaining concern is keeping the
 * public server model catalog available, with the same first-attempt/background
 * retry contract as before.
 */
class AuthService {
  private pendingServerModelLoad: {
    requestSnapshot: AuthAccountRequestSnapshot;
    promise: Promise<boolean>;
  } | null = null;
  private serverModelLoadSequence = 0;
  private lastRefreshTime = 0;

  init() {
    // Clean up any existing listeners to prevent stacking on repeated init()
    this.destroy();

    // Load the public catalog once at startup.
    void this.refreshServerModels();

    // Reload the catalog when the window regains focus (models may have
    // changed server-side) with a throttle.
    window.electron.window.onStateChanged((state) => {
      if (state.isFocused && !this.pendingServerModelLoad) {
        const now = Date.now();
        if (now - this.lastRefreshTime > 30_000) {
          this.lastRefreshTime = now;
          void this.refreshServerModels();
        }
      }
    });
  }

  /**
   * Re-fetch the plan model list after a recoverable outage (network restored,
   * manual refresh, focus regain).
   */
  async refreshServerModels(): Promise<boolean> {
    return this.loadServerModels();
  }

  private loadServerModels(): Promise<boolean> {
    return this.startServerModelLoad(this.currentSnapshot());
  }

  private currentSnapshot(): AuthAccountRequestSnapshot {
    return { accountGeneration: 0 };
  }

  private startServerModelLoad(requestSnapshot: AuthAccountRequestSnapshot): Promise<boolean> {
    if (
      this.pendingServerModelLoad
      && isAuthAccountRequestCurrent(
        this.pendingServerModelLoad.requestSnapshot,
        requestSnapshot,
      )
    ) {
      writeAuthRendererLog('debug', 'joining the in-flight server model load');
      return this.pendingServerModelLoad.promise;
    }

    let settleFirstAttempt!: (loaded: boolean) => void;
    const firstAttempt = new Promise<boolean>(resolve => {
      settleFirstAttempt = resolve;
    });
    this.pendingServerModelLoad = { requestSnapshot, promise: firstAttempt };
    void this.runServerModelLoad(settleFirstAttempt)
      .catch((error) => {
        writeAuthRendererLog('warn', 'server model load chain failed unexpectedly', error);
        settleFirstAttempt(false);
      })
      .finally(() => {
        if (this.pendingServerModelLoad?.promise === firstAttempt) {
          this.pendingServerModelLoad = null;
        }
      });
    return firstAttempt;
  }

  private async runServerModelLoad(
    settleFirstAttempt: (loaded: boolean) => void,
  ): Promise<void> {
    const loadSequence = this.serverModelLoadSequence;
    const totalAttempts = SERVER_MODEL_LOAD_RETRY_DELAYS_MS.length + 1;
    for (let attempt = 1; attempt <= totalAttempts; attempt++) {
      const outcome = await this.requestServerModels();
      if (attempt === 1) {
        settleFirstAttempt(outcome === ServerModelLoadOutcome.Loaded);
      }
      if (outcome !== ServerModelLoadOutcome.Retryable) return;
      if (attempt === totalAttempts) break;

      const delayMs = SERVER_MODEL_LOAD_RETRY_DELAYS_MS[attempt - 1];
      writeAuthRendererLog(
        'debug',
        `retrying the server model load in ${delayMs}ms (attempt ${attempt + 1}/${totalAttempts})`,
      );
      await new Promise<void>(resolve => { setTimeout(resolve, delayMs); });
      if (this.serverModelLoadSequence !== loadSequence) {
        writeAuthRendererLog('debug', 'abandoned the server model retry after the service restarted');
        return;
      }
    }
    writeAuthRendererLog(
      'warn',
      `server model load failed after ${totalAttempts} attempts; `
      + 'plan models stay unavailable until the next refresh',
    );
  }

  private async requestServerModels(): Promise<ServerModelLoadOutcome> {
    try {
      const catalogResult = await window.electron.auth.getPricingCatalog();
      if (catalogResult.success && catalogResult.textModels) {
        const serverModels = mapPricingCatalogToPublicServerModels({
          textModels: catalogResult.textModels,
        });
        store.dispatch(setServerModels(serverModels));
        writeAuthRendererLog(
          'debug',
          `loaded ${serverModels.length} public catalog model(s) into renderer state`,
        );
        return ServerModelLoadOutcome.Loaded;
      }
      writeAuthRendererLog('debug', 'public pricing catalog load returned no models');
      return ServerModelLoadOutcome.Retryable;
    } catch (error) {
      writeAuthRendererLog('debug', 'failed to load the public pricing catalog', error);
      return ServerModelLoadOutcome.Retryable;
    }
  }

  destroy() {
    this.pendingServerModelLoad = null;
    this.serverModelLoadSequence += 1;
  }
}

export const authService = new AuthService();
