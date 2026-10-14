import { CheckIcon } from '@heroicons/react/24/outline';
import { MediaProviderUiEvent } from '@shared/cowork/mediaProviders';
import { canonicalizeMediaModelId, mediaModelDisplayName } from '@shared/mediaModelAliases';
import { ProviderName } from '@shared/providers';
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDispatch, useSelector } from 'react-redux';

import { getProviderIcon, ProviderIconId } from '../../providers/uiRegistry';
import { i18nService } from '../../services/i18n';
import { localStore } from '../../services/store';
import { RootState } from '../../store';
import { setMediaModels, setMediaSelection } from '../../store/slices/coworkSlice';
import type { MediaGenerationMode, MediaModel } from '../../types/mediaGeneration';
import MagicIcon from '../icons/MagicIcon';
import { resolvePopoverPlacement } from './popoverPlacement';

interface SavedMediaSelection {
  image?: { modelId: string; modelName: string };
  video?: { modelId: string; modelName: string };
}

const MEDIA_SELECTION_KV_KEY = 'media_selection';
// The model list needs room for the longest name next to a price such as
// "x30-60 积分/张输出图".
const MEDIA_MODEL_LIST_PANEL_WIDTH = 400;
const MEDIA_PANEL_ESTIMATED_HEIGHT = 380;
const EMPTY_MEDIA_MODELS: { image: MediaModel[]; video: MediaModel[] } = {
  image: [],
  video: [],
};

const logMediaModelPickerDiagnostic = (
  level: 'debug' | 'warn',
  message: string,
  error?: unknown,
): void => {
  const errorMessage = error === undefined
    ? ''
    : `: ${error instanceof Error ? error.message : String(error)}`;
  const resolvedMessage = `${message}${errorMessage}`.replace(/\s+/g, ' ').trim().slice(0, 500);
  if (level === 'warn') {
    console.warn(`[MediaModelPicker] ${resolvedMessage}`);
  } else {
    console.debug(`[MediaModelPicker] ${resolvedMessage}`);
  }
  try {
    window.electron?.log?.fromRenderer?.(level, 'MediaModelPicker', resolvedMessage);
  } catch {
    // Diagnostics must not interrupt model selection or local persistence.
  }
};

type MediaIconKey = ProviderName | ProviderIconId;

const normalizeMediaModel = (model: MediaModel): MediaModel => {
  const modelId = canonicalizeMediaModelId(model.modelId);
  const displayName = mediaModelDisplayName(modelId, model.displayName);
  if (modelId === model.modelId && displayName === model.displayName) {
    return model;
  }
  return { ...model, modelId, displayName };
};

const normalizeSavedMediaSelectionEntry = (
  entry: { modelId: string; modelName: string } | undefined,
): { modelId: string; modelName: string } | undefined => {
  if (!entry) return undefined;
  const modelId = canonicalizeMediaModelId(entry.modelId);
  return {
    modelId,
    modelName: mediaModelDisplayName(modelId, entry.modelName),
  };
};

const normalizeSavedMediaSelection = (saved: SavedMediaSelection | null | undefined): SavedMediaSelection => {
  const image = normalizeSavedMediaSelectionEntry(saved?.image);
  const video = normalizeSavedMediaSelectionEntry(saved?.video);
  return {
    ...(image ? { image } : {}),
    ...(video ? { video } : {}),
  };
};

const isSameSavedMediaSelection = (
  left: SavedMediaSelection | null | undefined,
  right: SavedMediaSelection,
): boolean => (
  left?.image?.modelId === right.image?.modelId
  && left?.image?.modelName === right.image?.modelName
  && left?.video?.modelId === right.video?.modelId
  && left?.video?.modelName === right.video?.modelName
);

const pendingSavedMediaSelectionLoads = new Map<
  string,
  Promise<SavedMediaSelection | null>
>();

// Media generation runs on the user's own local providers (no account
// scoping): the scope key is a stable "local" constant for model caching and
// selection persistence.
const getMediaSelectionStoreKey = (mediaScopeKey: string): string => (
  `${MEDIA_SELECTION_KV_KEY}:${mediaScopeKey}`
);

const loadSavedMediaSelection = (
  mediaScopeKey: string,
): Promise<SavedMediaSelection | null> => {
  const pending = pendingSavedMediaSelectionLoads.get(mediaScopeKey);
  if (pending) return pending;

  const selectionStoreKey = getMediaSelectionStoreKey(mediaScopeKey);
  const load = (async () => {
    const scopedSelection = await localStore.getItem<SavedMediaSelection>(selectionStoreKey);
    if (scopedSelection !== null) return scopedSelection;

    const legacySelection = await localStore.getItem<SavedMediaSelection>(MEDIA_SELECTION_KV_KEY);
    if (legacySelection === null) return null;

    const normalizedSelection = normalizeSavedMediaSelection(legacySelection);
    try {
      await localStore.setItem(selectionStoreKey, normalizedSelection);
      await localStore.removeItem(MEDIA_SELECTION_KV_KEY);
      logMediaModelPickerDiagnostic('debug', 'migrated legacy media selection to the current scope');
    } catch (error) {
      logMediaModelPickerDiagnostic('warn', 'failed to persist media selection for the current scope', error);
    }
    return normalizedSelection;
  })().finally(() => {
    if (pendingSavedMediaSelectionLoads.get(mediaScopeKey) === load) {
      pendingSavedMediaSelectionLoads.delete(mediaScopeKey);
    }
  });
  pendingSavedMediaSelectionLoads.set(mediaScopeKey, load);
  return load;
};

const MEDIA_ICON_HINTS: Array<{ pattern: RegExp; iconKey: MediaIconKey }> = [
  { pattern: /gpt[\s-]*image[\s-]*2|canvas[\s-]*20/i, iconKey: ProviderName.OpenAI },
  { pattern: /nano[\s-]*banana[\s-]*(?:2|pro)|nano[\s-]*banan[\s-]*(?:2|pro)|banana[\s-]*(?:2|pro)/i, iconKey: ProviderIconId.Banana },
  { pattern: /doubao|seedream|豆包/i, iconKey: ProviderIconId.Doubao },
  { pattern: /minimax/i, iconKey: ProviderName.Minimax },
  { pattern: /qwen|qwq|wan2\.7|z-image/i, iconKey: ProviderName.Qwen },
  { pattern: /kling/i, iconKey: ProviderIconId.Kling },
  { pattern: /happyhorse|happy.horse/i, iconKey: ProviderIconId.HappyHorse },
];

interface MediaPricingTierConfig {
  label?: string;
  resolution?: string;
  duration?: number;
  audio?: boolean;
  hasVideoInput?: boolean;
  outputPixelsMin?: number | string;
  outputPixelsMax?: number | string;
  costYuan?: number | string;
  outputCostYuan?: number | string;
  credits?: number | string;
  outputCredits?: number | string;
  pricePerMillionTokens?: number | string;
}

interface MediaPricingConfig {
  billingUnit?: string;
  adapterType?: string;
  currency?: string;
  pricingModel?: string;
  usdToCny?: number | string;
  unitLabel?: string;
  upstreamModelId?: string;
  inputCostYuan?: number | string;
  inputCredits?: number | string;
  freeInputImageCount?: number | string;
  inputFreeCount?: number | string;
  freeInputImages?: number | string;
  outputCostYuan?: number | string;
  outputCredits?: number | string;
  usagePricing?: TokenUsagePricing;
  estimatedUsage?: EstimatedTokenUsage;
  defaultParams?: Record<string, unknown>;
  tiers?: MediaPricingTierConfig[];
}

interface TokenUsagePricing {
  textInputUsdPerMillion?: number;
  imageInputUsdPerMillion?: number;
  cachedInputUsdPerMillion?: number;
  cachedImageInputUsdPerMillion?: number;
  textOutputUsdPerMillion?: number;
  imageOutputUsdPerMillion?: number;
  thinkingOutputUsdPerMillion?: number;
}

interface EstimatedTokenUsage {
  textInputTokens?: number;
  imageInputTokensPerImage?: number;
  cachedInputTokens?: number;
  cachedImageInputTokens?: number;
  textOutputTokens?: number;
  imageOutputTokensPerImage?: number;
  thinkingOutputTokens?: number;
}

const CREDITS_PER_CNY = 100;
// Fallback USD→CNY rate used when a model does not declare its own `usdToCny`.
const DEFAULT_USD_TO_CNY = 7;

const TOKEN_PRICING_FIELDS: Array<{ key: keyof TokenUsagePricing; labelKey: string }> = [
  { key: 'textInputUsdPerMillion', labelKey: 'mediaTokenPricingTextInput' },
  { key: 'imageInputUsdPerMillion', labelKey: 'mediaTokenPricingImageInput' },
  { key: 'cachedInputUsdPerMillion', labelKey: 'mediaTokenPricingCachedInput' },
  { key: 'cachedImageInputUsdPerMillion', labelKey: 'mediaTokenPricingCachedImageInput' },
  { key: 'textOutputUsdPerMillion', labelKey: 'mediaTokenPricingTextOutput' },
  { key: 'imageOutputUsdPerMillion', labelKey: 'mediaTokenPricingImageOutput' },
  { key: 'thinkingOutputUsdPerMillion', labelKey: 'mediaTokenPricingThinkingOutput' },
];

const toFiniteNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};

const countArrayParam = (value: unknown): number => Array.isArray(value) ? value.length : 0;

const getPricingConfig = (model: MediaModel): MediaPricingConfig | undefined => {
  if (!model.pricing || typeof model.pricing !== 'object') return undefined;
  return model.pricing as MediaPricingConfig;
};

const isTokenBillingModel = (model: MediaModel): boolean => {
  return getPricingConfig(model)?.billingUnit === 'per_token';
};

const isImageIoBillingModel = (model: MediaModel): boolean => {
  return getPricingConfig(model)?.billingUnit === 'per_image_io';
};

const getCreditsPerUsd = (pricing?: MediaPricingConfig): number => {
  const usdToCny = toFiniteNumber(pricing?.usdToCny) ?? DEFAULT_USD_TO_CNY;
  return usdToCny * CREDITS_PER_CNY;
};

const usageCostCredits = (tokens: number | undefined, usdPerMillion: number | undefined, creditsPerUsd: number): number => {
  if (!tokens || !usdPerMillion) return 0;
  return tokens * usdPerMillion / 1_000_000 * creditsPerUsd;
};

const getDefaultOutputImageCount = (defaultParams?: Record<string, unknown>): number => {
  const count = toFiniteNumber(defaultParams?.n) ?? toFiniteNumber(defaultParams?.count) ?? 1;
  return Math.max(1, Math.floor(count));
};

const getDefaultInputImageCount = (defaultParams?: Record<string, unknown>): number => {
  if (!defaultParams) return 0;
  return countArrayParam(defaultParams.images)
    + countArrayParam(defaultParams.referenceImages)
    + countArrayParam(defaultParams.imageUrls);
};

const calculateEstimatedTokenCredits = (model: MediaModel): number | undefined => {
  const pricing = getPricingConfig(model);
  const usagePricing = pricing?.usagePricing;
  const estimatedUsage = pricing?.estimatedUsage;
  if (!usagePricing || !estimatedUsage) return undefined;

  const defaultParams = pricing?.defaultParams;
  const creditsPerUsd = getCreditsPerUsd(pricing);
  const outputImages = getDefaultOutputImageCount(defaultParams);
  const inputImages = getDefaultInputImageCount(defaultParams);

  const credits =
    usageCostCredits(estimatedUsage.textInputTokens, usagePricing.textInputUsdPerMillion, creditsPerUsd)
    + usageCostCredits(
      inputImages * (estimatedUsage.imageInputTokensPerImage ?? 0),
      usagePricing.imageInputUsdPerMillion,
      creditsPerUsd,
    )
    + usageCostCredits(estimatedUsage.cachedInputTokens, usagePricing.cachedInputUsdPerMillion, creditsPerUsd)
    + usageCostCredits(
      estimatedUsage.cachedImageInputTokens,
      usagePricing.cachedImageInputUsdPerMillion,
      creditsPerUsd,
    )
    + usageCostCredits(estimatedUsage.textOutputTokens, usagePricing.textOutputUsdPerMillion, creditsPerUsd)
    + usageCostCredits(
      outputImages * (estimatedUsage.imageOutputTokensPerImage ?? 0),
      usagePricing.imageOutputUsdPerMillion,
      creditsPerUsd,
    )
    + usageCostCredits(estimatedUsage.thinkingOutputTokens, usagePricing.thinkingOutputUsdPerMillion, creditsPerUsd);

  return credits > 0 ? credits : undefined;
};

const getEstimatedRequestCredits = (model: MediaModel): number | undefined => {
  if (!isTokenBillingModel(model)) return undefined;
  const unitCredits = toFiniteNumber(model.unitCredits);
  if (unitCredits && unitCredits > 0) return unitCredits;
  return calculateEstimatedTokenCredits(model);
};

const formatCreditAmount = (credits: number): string => {
  if (Number.isInteger(credits)) return credits.toString();
  return credits.toFixed(2).replace(/\.?0+$/, '');
};

const formatEstimatedCredits = (credits: number): string => {
  return Math.max(1, Math.round(credits)).toString();
};

const pricingCredits = (creditsValue: unknown, costYuanValue: unknown): number | undefined => {
  const directCredits = toFiniteNumber(creditsValue);
  if (directCredits != null) return directCredits;
  const costYuan = toFiniteNumber(costYuanValue);
  if (costYuan != null) return costYuan * CREDITS_PER_CNY;
  return undefined;
};

const tierCredits = (tier: MediaPricingTierConfig): number => {
  const credits = pricingCredits(tier.outputCredits ?? tier.credits, tier.outputCostYuan ?? tier.costYuan);
  if (credits != null) return credits;
  const pricePerMillionTokens = toFiniteNumber(tier.pricePerMillionTokens);
  if (pricePerMillionTokens != null) return pricePerMillionTokens * CREDITS_PER_CNY;
  return 0;
};

const formatPixelCount = (pixels: number): string => {
  if (i18nService.getLanguage() === 'zh') {
    if (pixels >= 10_000) return `${formatCreditAmount(pixels / 10_000)}万`;
    return formatCreditAmount(pixels);
  }
  if (pixels >= 1_000_000) return `${formatCreditAmount(pixels / 1_000_000)}M`;
  if (pixels >= 1_000) return `${formatCreditAmount(pixels / 1_000)}K`;
  return formatCreditAmount(pixels);
};

const formatOutputPixelTierLabel = (tier: MediaPricingTierConfig): string => {
  if (tier.label) return tier.label;
  const min = toFiniteNumber(tier.outputPixelsMin);
  const max = toFiniteNumber(tier.outputPixelsMax);
  const isZh = i18nService.getLanguage() === 'zh';
  if (min != null && max != null) {
    return isZh
      ? `输出图${formatPixelCount(min)}-${formatPixelCount(max)}像素`
      : `Output ${formatPixelCount(min)}-${formatPixelCount(max)} pixels`;
  }
  if (max != null) {
    return isZh
      ? `输出图≤${formatPixelCount(max)}像素`
      : `Output ≤ ${formatPixelCount(max)} pixels`;
  }
  if (min != null) {
    return isZh
      ? `输出图>${formatPixelCount(min - 1)}像素`
      : `Output > ${formatPixelCount(min - 1)} pixels`;
  }
  return isZh ? '输出图' : 'Output image';
};

const getImageIoOutputTierCredits = (pricing?: MediaPricingConfig): number[] => {
  const tierCreditsList = pricing?.tiers
    ?.map(tier => tierCredits(tier))
    .filter(credits => credits > 0) ?? [];
  if (tierCreditsList.length > 0) return tierCreditsList;
  const outputCredits = pricingCredits(pricing?.outputCredits, pricing?.outputCostYuan);
  return outputCredits != null && outputCredits > 0 ? [outputCredits] : [];
};

const getFreeInputImageCount = (pricing?: MediaPricingConfig): number => {
  const freeCount = toFiniteNumber(
    pricing?.freeInputImageCount ?? pricing?.inputFreeCount ?? pricing?.freeInputImages,
  );
  if (freeCount == null || freeCount <= 0) return 0;
  return Math.floor(freeCount);
};

const getModelPriceLabel = (model: MediaModel): string | null => {
  if (model.mediaType !== 'image') return null;
  if (isTokenBillingModel(model)) {
    const estimatedCredits = getEstimatedRequestCredits(model);
    if (!estimatedCredits) return null;
    return `≈${formatEstimatedCredits(estimatedCredits)} ${i18nService.t('authCreditsUnit')}/${model.unitLabel || '次'}`;
  }
  if (isImageIoBillingModel(model)) {
    const outputTierCredits = getImageIoOutputTierCredits(getPricingConfig(model));
    if (outputTierCredits.length === 0) return null;
    const minCredits = Math.min(...outputTierCredits);
    const maxCredits = Math.max(...outputTierCredits);
    const creditRange = minCredits === maxCredits
      ? formatCreditAmount(minCredits)
      : `${formatCreditAmount(minCredits)}-${formatCreditAmount(maxCredits)}`;
    return `x${creditRange} ${i18nService.t('authCreditsUnit')}/${model.unitLabel || '张输出图'}`;
  }
  const unitCredits = toFiniteNumber(model.unitCredits);
  if (!unitCredits || unitCredits <= 0) return null;
  return `x${formatCreditAmount(unitCredits)} ${i18nService.t('authCreditsUnit')}/${model.unitLabel || '张'}`;
};

const normalizeModelDescription = (description?: string): string | undefined => {
  if (!description) return undefined;
  const normalized = description.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').trim();
  return normalized || undefined;
};

const getTokenPricingRows = (model: MediaModel): Array<{ label: string; creditsPerMillion: number }> => {
  const pricing = getPricingConfig(model);
  if (pricing?.billingUnit !== 'per_token' || !pricing.usagePricing) return [];
  const creditsPerUsd = getCreditsPerUsd(pricing);
  return TOKEN_PRICING_FIELDS
    .map(({ key, labelKey }) => {
      const usdPerMillion = toFiniteNumber(pricing.usagePricing?.[key]);
      if (!usdPerMillion || usdPerMillion <= 0) return null;
      return {
        label: i18nService.t(labelKey),
        creditsPerMillion: usdPerMillion * creditsPerUsd,
      };
    })
    .filter((row): row is { label: string; creditsPerMillion: number } => row !== null);
};

const getImageIoPricingRows = (model: MediaModel): Array<{ label: string; credits: number; unitLabel: string }> => {
  const pricing = getPricingConfig(model);
  if (pricing?.billingUnit !== 'per_image_io') return [];
  const rows: Array<{ label: string; credits: number; unitLabel: string }> = [];
  const inputCredits = pricingCredits(pricing.inputCredits, pricing.inputCostYuan);
  if (inputCredits != null && inputCredits > 0) {
    const freeInputImageCount = getFreeInputImageCount(pricing);
    rows.push({
      label: (() => {
        const isZh = i18nService.getLanguage() === 'zh';
        if (freeInputImageCount === 1) return isZh ? '输入图（首张免费）' : 'Input image (first free)';
        if (freeInputImageCount > 1) return isZh
          ? `输入图（前${freeInputImageCount}张免费）`
          : `Input image (first ${freeInputImageCount} free)`;
        return isZh ? '输入图' : 'Input image';
      })(),
      credits: inputCredits,
      unitLabel: i18nService.getLanguage() === 'zh' ? '张输入图' : 'input image',
    });
  }

  const outputUnitLabel = model.unitLabel || pricing.unitLabel || (i18nService.getLanguage() === 'zh' ? '张输出图' : 'output image');
  pricing.tiers?.forEach((tier) => {
    const credits = tierCredits(tier);
    if (credits <= 0) return;
    rows.push({
      label: formatOutputPixelTierLabel(tier),
      credits,
      unitLabel: outputUnitLabel,
    });
  });

  if (!pricing.tiers || pricing.tiers.length === 0) {
    const outputCredits = pricingCredits(pricing.outputCredits, pricing.outputCostYuan);
    if (outputCredits != null && outputCredits > 0) {
      rows.push({
        label: i18nService.getLanguage() === 'zh' ? '输出图' : 'Output image',
        credits: outputCredits,
        unitLabel: outputUnitLabel,
      });
    }
  }
  return rows;
};

const getTokenBillingEstimateNotes = (): string[] => {
  return [i18nService.t('mediaTokenBillingEstimateNote')];
};

const resolveMediaModelIcon = (model: MediaModel): React.ReactNode => {
  const text = `${model.displayName} ${model.modelId}`;
  const hint = MEDIA_ICON_HINTS.find(({ pattern }) => pattern.test(text));
  return getProviderIcon(hint?.iconKey ?? ProviderName.Custom);
};

interface MediaModelPickerProps {
  draftKey: string;
  disabled?: boolean;
}

const MediaModelPicker: React.FC<MediaModelPickerProps> = ({ draftKey, disabled }) => {
  const dispatch = useDispatch();
  const [isOpen, setIsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<'image' | 'video'>('image');
  const [isLoading, setIsLoading] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [hoveredModel, setHoveredModel] = useState<MediaModel | null>(null);
  const [hoverCardStyle, setHoverCardStyle] = useState<React.CSSProperties>({});
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fetchRequestIdRef = useRef(0);
  // Stable per-run generation so scope guards keep their signatures; media
  // selection state no longer resets on account changes (no accounts).
  const accountGenerationRef = useRef(0);

  // Media generation is backed by the user's own local providers (no account
  // scoping); the scope key is a stable per-run constant so cache semantics
  // keep working unchanged.
  const mediaScopeKey = 'local';
  const desiredPanelWidth = MEDIA_MODEL_LIST_PANEL_WIDTH;
  const containerRef = useRef<HTMLDivElement>(null);
  const [panelPlacement, setPanelPlacement] = useState(() => ({
    alignEnd: false,
    width: desiredPanelWidth,
  }));

  const cachedMediaModels = useSelector((state: RootState) => state.cowork.mediaModels);
  const mediaModelsScopeKey = useSelector(
    (state: RootState) => state.cowork.mediaModelsScopeKey,
  );
  const mediaModels = mediaScopeKey === mediaModelsScopeKey
    ? cachedMediaModels
    : EMPTY_MEDIA_MODELS;
  const mediaModelsRef = useRef(mediaModels);
  mediaModelsRef.current = mediaModels;
  const selection = useSelector((state: RootState) => state.cowork.mediaSelection[draftKey]);

  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const isMediaScopeCurrent = useCallback((
    _expectedMediaScopeKey: string,
    expectedGeneration: number,
  ): boolean => expectedGeneration === accountGenerationRef.current, []);

  const fetchModels = useCallback(async () => {
    const requestScopeKey = mediaScopeKey;
    const requestGeneration = accountGenerationRef.current;
    const requestId = ++fetchRequestIdRef.current;
    const selectionStoreKey = getMediaSelectionStoreKey(requestScopeKey);
    const currentMediaModels = mediaModelsRef.current;
    const hasCachedModels = currentMediaModels.image.length > 0
      || currentMediaModels.video.length > 0;
    if (!hasCachedModels) {
      setIsLoading(true);
    }
    try {
      const [imageResult, videoResult] = await Promise.all([
        window.electron.media.getModels('image'),
        window.electron.media.getModels('video'),
      ]);
      if (
        fetchRequestIdRef.current !== requestId
        || !isMediaScopeCurrent(requestScopeKey, requestGeneration)
      ) return;
      if (!imageResult.success) {
        logMediaModelPickerDiagnostic('warn', 'image models fetch failed', imageResult.error);
      }
      if (!videoResult.success) {
        logMediaModelPickerDiagnostic('warn', 'video models fetch failed', videoResult.error);
      }
      const imageModels = ((imageResult.models || []) as MediaModel[]).map(normalizeMediaModel);
      const videoModels = ((videoResult.models || []) as MediaModel[]).map(normalizeMediaModel);
      dispatch(setMediaModels({
        image: imageModels,
        video: videoModels,
        scopeKey: requestScopeKey,
      }));
      const currentSelection = selectionRef.current;
      if (!currentSelection || currentSelection.mode === 'none') {
        const rawSaved = await loadSavedMediaSelection(requestScopeKey);
        if (
          fetchRequestIdRef.current !== requestId
          || !isMediaScopeCurrent(requestScopeKey, requestGeneration)
        ) return;
        const saved = normalizeSavedMediaSelection(rawSaved);
        if (!isSameSavedMediaSelection(rawSaved, saved)) {
          await localStore.setItem(selectionStoreKey, saved);
        }
        const imageEntry = saved?.image;
        const videoEntry = saved?.video;
        const imageValid = imageEntry && imageModels.some(m => m.modelId === imageEntry.modelId);
        const videoValid = videoEntry && videoModels.some(m => m.modelId === videoEntry.modelId);

        if (imageValid && videoValid) {
          dispatch(setMediaSelection({
            draftKey,
            selection: {
              mode: 'auto',
              modelId: imageEntry.modelId,
              modelName: imageEntry.modelName,
              imageModelId: imageEntry.modelId,
              videoModelId: videoEntry!.modelId,
            },
          }));
        } else if (imageValid) {
          dispatch(setMediaSelection({
            draftKey,
            selection: { mode: 'image', modelId: imageEntry.modelId, modelName: imageEntry.modelName },
          }));
        } else if (videoValid) {
          dispatch(setMediaSelection({
            draftKey,
            selection: { mode: 'video', modelId: videoEntry!.modelId, modelName: videoEntry!.modelName },
          }));
          setActiveTab('video');
        }
      }
    } catch (err) {
      logMediaModelPickerDiagnostic('warn', 'failed to fetch models', err);
    } finally {
      if (
        fetchRequestIdRef.current === requestId
        && isMediaScopeCurrent(requestScopeKey, requestGeneration)
      ) {
        setIsLoading(false);
      }
    }
  }, [
    dispatch,
    draftKey,
    isMediaScopeCurrent,
    mediaScopeKey,
  ]);

  useEffect(() => {
    fetchRequestIdRef.current += 1;
    setIsLoading(false);
  }, [mediaScopeKey]);

  useEffect(() => {
    if (isOpen) {
      fetchModels();
    }
  }, [isOpen, fetchModels]);

  useLayoutEffect(() => {
    if (!isOpen) return;
    // The panel grows rightward from the trigger; flip it (or cap its width)
    // when a clipping ancestor such as a narrow chat pane cannot fit it.
    const updatePlacement = () => {
      const container = containerRef.current;
      if (!container) return;
      const placement = resolvePopoverPlacement(container, {
        preferredAlign: 'left',
        estimatedHeight: MEDIA_PANEL_ESTIMATED_HEIGHT,
        desiredWidth: desiredPanelWidth,
      });
      const next = {
        alignEnd: placement.alignSide === 'right',
        width: placement.maxWidth ?? desiredPanelWidth,
      };
      setPanelPlacement(current => (
        current.alignEnd === next.alignEnd && current.width === next.width ? current : next
      ));
    };
    updatePlacement();
    window.addEventListener('resize', updatePlacement);
    return () => window.removeEventListener('resize', updatePlacement);
  }, [isOpen, desiredPanelWidth]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node) &&
          buttonRef.current && !buttonRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen]);

  useEffect(() => {
    if (selection && selection.mode !== 'none') {
      return;
    }

    let cancelled = false;
    const restoreScopeKey = mediaScopeKey;
    const restoreGeneration = accountGenerationRef.current;
    const selectionStoreKey = getMediaSelectionStoreKey(restoreScopeKey);
    void (async () => {
      try {
        const rawSaved = await loadSavedMediaSelection(restoreScopeKey);
        const saved = normalizeSavedMediaSelection(rawSaved);
        if (!isSameSavedMediaSelection(rawSaved, saved)) {
          await localStore.setItem(selectionStoreKey, saved);
        }
        if (
          cancelled
          || !isMediaScopeCurrent(restoreScopeKey, restoreGeneration)
        ) {
          return;
        }
        const imageEntry = saved.image;
        const videoEntry = saved.video;
        if (imageEntry && videoEntry) {
          dispatch(setMediaSelection({
            draftKey,
            selection: {
              mode: 'auto',
              modelId: imageEntry.modelId,
              modelName: imageEntry.modelName,
              imageModelId: imageEntry.modelId,
              videoModelId: videoEntry.modelId,
            },
          }));
        } else if (imageEntry) {
          dispatch(setMediaSelection({
            draftKey,
            selection: { mode: 'image', modelId: imageEntry.modelId, modelName: imageEntry.modelName },
          }));
        } else if (videoEntry) {
          dispatch(setMediaSelection({
            draftKey,
            selection: { mode: 'video', modelId: videoEntry.modelId, modelName: videoEntry.modelName },
          }));
          setActiveTab('video');
        }
      } catch (error) {
        logMediaModelPickerDiagnostic('warn', 'failed to restore saved media selection', error);
      }
    })();
    return () => { cancelled = true; };
  }, [
    dispatch,
    draftKey,
    isMediaScopeCurrent,
    mediaScopeKey,
    selection,
  ]);

  const handleSelect = async (mode: MediaGenerationMode, model?: MediaModel) => {
    const selectionScopeKey = mediaScopeKey;
    const selectionGeneration = accountGenerationRef.current;
    const selectionStoreKey = getMediaSelectionStoreKey(selectionScopeKey);
    let saved: SavedMediaSelection;
    try {
      saved = normalizeSavedMediaSelection(
        await loadSavedMediaSelection(selectionScopeKey),
      );
    } catch (error) {
      logMediaModelPickerDiagnostic('warn', 'failed to load saved media selection', error);
      saved = {};
    }
    if (!isMediaScopeCurrent(selectionScopeKey, selectionGeneration)) return;
    const currentModelId = mode === 'image'
      ? canonicalizeMediaModelId(selection?.imageModelId ?? (selection?.mode === 'image' ? selection?.modelId : undefined))
      : canonicalizeMediaModelId(selection?.videoModelId ?? (selection?.mode === 'video' ? selection?.modelId : undefined));
    const isDeselect = model && currentModelId === model.modelId;

    if (isDeselect) {
      delete saved[mode as 'image' | 'video'];
    } else if (model) {
      saved[mode as 'image' | 'video'] = { modelId: model.modelId, modelName: model.displayName };
    }
    try {
      await localStore.setItem(selectionStoreKey, saved);
    } catch (error) {
      logMediaModelPickerDiagnostic('warn', 'failed to save media selection', error);
    }
    if (!isMediaScopeCurrent(selectionScopeKey, selectionGeneration)) return;

    const hasImage = !!saved.image;
    const hasVideo = !!saved.video;

    if (hasImage && hasVideo) {
      dispatch(setMediaSelection({
        draftKey,
        selection: {
          mode: 'auto',
          modelId: saved[mode as 'image' | 'video']?.modelId,
          modelName: saved[mode as 'image' | 'video']?.modelName,
          imageModelId: saved.image!.modelId,
          videoModelId: saved.video!.modelId,
        },
      }));
    } else if (hasImage) {
      dispatch(setMediaSelection({
        draftKey,
        selection: { mode: 'image', modelId: saved.image!.modelId, modelName: saved.image!.modelName },
      }));
    } else if (hasVideo) {
      dispatch(setMediaSelection({
        draftKey,
        selection: { mode: 'video', modelId: saved.video!.modelId, modelName: saved.video!.modelName },
      }));
    } else {
      dispatch(setMediaSelection({ draftKey, selection: { mode: 'none' } }));
    }
  };

  /**
   * Jumps to the settings tab where media providers are configured. The picker
   * is rendered deep inside the prompt input, so the app shell listens for this
   * broadcast event instead of the callback being threaded through every
   * intermediate component.
   */
  const handleOpenProviderSettings = () => {
    setIsOpen(false);
    window.dispatchEvent(new Event(MediaProviderUiEvent.OpenSettings));
  };

  const handleModelHover = (model: MediaModel, event: React.MouseEvent<HTMLButtonElement>) => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    const itemRect = event.currentTarget.getBoundingClientRect();
    hoverTimerRef.current = setTimeout(() => {
      const desc = normalizeModelDescription(model.description || model.capabilities || model.pricingDescription);
      const hasPricingDetails = Boolean(getModelPriceLabel(model)) || getTokenPricingRows(model).length > 0;
      if (!desc && !hasPricingDetails) {
        setHoveredModel(null);
        return;
      }
      const dropdownEl = dropdownRef.current;
      if (!dropdownEl) return;
      const dropdownRect = dropdownEl.getBoundingClientRect();
      const spaceRight = window.innerWidth - dropdownRect.right;
      const cardWidth = 280;
      const style: React.CSSProperties = {
        position: 'fixed',
        zIndex: 10001,
      };
      const cardHeight = 300;
      if (itemRect.top + cardHeight > window.innerHeight) {
        style.bottom = 8;
      } else {
        style.top = itemRect.top;
      }
      if (spaceRight >= cardWidth + 8) {
        style.left = dropdownRect.right + 8;
      } else {
        style.right = window.innerWidth - dropdownRect.left + 8;
      }
      setHoverCardStyle(style);
      setHoveredModel(model);
    }, 200);
  };

  const handleModelHoverEnd = () => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    setHoveredModel(null);
  };

  useEffect(() => {
    if (!isOpen) setHoveredModel(null);
  }, [isOpen]);

  useEffect(() => {
    return () => {
      fetchRequestIdRef.current += 1;
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    };
  }, []);

  const renderHoverCard = () => {
    if (!hoveredModel) return null;
    const desc = normalizeModelDescription(hoveredModel.description || hoveredModel.capabilities || hoveredModel.pricingDescription);
    const unitLabel = hoveredModel.unitLabel || (hoveredModel.mediaType === 'image' ? '张' : '个');
    const pricing = getPricingConfig(hoveredModel);
    const tiers = pricing?.tiers;
    const billingUnit = pricing?.billingUnit;
    const tokenPricingRows = getTokenPricingRows(hoveredModel);
    const imageIoPricingRows = getImageIoPricingRows(hoveredModel);
    const tokenBillingEstimateNotes = getTokenBillingEstimateNotes();

    const formatTierLabel = (tier: MediaPricingTierConfig) => {
      if (tier.label) return tier.label;
      if (tier.outputPixelsMin != null || tier.outputPixelsMax != null) return formatOutputPixelTierLabel(tier);
      const parts: string[] = [];
      if (tier.resolution) parts.push(tier.resolution);
      if (tier.duration) parts.push(`${tier.duration}秒`);
      if (tier.audio) parts.push('有声音');
      if (tier.hasVideoInput === true) parts.push('含视频输入');
      if (tier.hasVideoInput === false) parts.push('不含视频输入');
      return parts.join(' ') || '-';
    };

    const tierUnitSuffix = billingUnit === 'per_second' ? '秒'
      : billingUnit === 'per_video' ? '个'
      : billingUnit === 'per_token' ? '百万tokens'
      : unitLabel;

    const hasVideoInputTiers = tiers && tiers.some(t => t.hasVideoInput !== undefined);
    const tierRows = (() => {
      if (!tiers || tiers.length <= 1) return null;
      if (!hasVideoInputTiers) return null;
      const resolutions = [...new Set(tiers.map(t => t.resolution).filter(Boolean))] as string[];
      return resolutions.map(res => {
        const withVideo = tiers.find(t => t.resolution === res && t.hasVideoInput === true);
        const withoutVideo = tiers.find(t => t.resolution === res && t.hasVideoInput === false);
        return { resolution: res, withVideo, withoutVideo };
      });
    })();

    const card = (
      <div style={hoverCardStyle} className="w-[280px] rounded-xl border border-border bg-surface shadow-popover p-3 pointer-events-none">
        <div className="flex min-w-0 items-center gap-1.5 text-[13px] font-semibold text-foreground leading-5">
          <span className="min-w-0 truncate">{hoveredModel.displayName}</span>
        </div>
        {desc && (
          <div className="mt-1 whitespace-pre-line text-[11px] text-secondary leading-4">
            {desc}
          </div>
        )}
        {imageIoPricingRows.length > 0 ? (
          <>
            <table className="mt-2 w-full text-[10px] text-secondary border-collapse">
              <thead>
                <tr className="border-b border-border/50">
                  <th className="text-left font-medium py-0.5 pr-2">{i18nService.t('mediaTierSpecLabel')}</th>
                  <th className="text-right font-medium py-0.5">{i18nService.t('authCreditsUnit')}</th>
                </tr>
              </thead>
              <tbody>
                {imageIoPricingRows.map((row) => (
                  <tr key={`${row.label}-${row.unitLabel}`}>
                    <td className="py-0.5 pr-2">{row.label}</td>
                    <td className="text-right py-0.5">
                      {formatCreditAmount(row.credits)}/{row.unitLabel}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-1.5 text-[9px] leading-3 text-tertiary">
              {i18nService.getLanguage() === 'zh'
                ? '输出图按实际返回的图片尺寸分层计费。'
                : 'Output image billing is tiered by the actual returned image size.'}
            </div>
          </>
        ) : tokenPricingRows.length > 0 ? (
          <>
            <table className="mt-2 w-full text-[10px] text-secondary border-collapse">
              <thead>
                <tr className="border-b border-border/50">
                  <th className="text-left font-medium py-0.5 pr-2">{i18nService.t('mediaTierSpecLabel')}</th>
                  <th className="text-right font-medium py-0.5">
                    {i18nService.t('authCreditsUnit')}/{i18nService.t('mediaMillionTokensUnit')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {tokenPricingRows.map((row) => (
                  <tr key={row.label}>
                    <td className="py-0.5 pr-2">{row.label}</td>
                    <td className="text-right py-0.5">{formatCreditAmount(row.creditsPerMillion)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-1.5 space-y-1 text-[9px] leading-3 text-tertiary">
              {tokenBillingEstimateNotes.map((note, index) => (
                <div key={index}>{note}</div>
              ))}
            </div>
          </>
        ) : tiers && tiers.length > 1 ? (
          tierRows ? (
            <table className="mt-2 w-full text-[10px] text-secondary border-collapse">
              <thead>
                <tr className="border-b border-border/50">
                  <th className="text-left font-medium py-0.5 pr-1"></th>
                  <th className="text-right font-medium py-0.5 px-1">含视频输入</th>
                  <th className="text-right font-medium py-0.5">不含视频输入</th>
                </tr>
              </thead>
              <tbody>
                {tierRows.map((row) => (
                  <tr key={row.resolution}>
                    <td className="py-0.5 pr-1">{row.resolution}</td>
                    <td className="text-right py-0.5 px-1">{row.withVideo ? tierCredits(row.withVideo) : '-'}</td>
                    <td className="text-right py-0.5">{row.withoutVideo ? tierCredits(row.withoutVideo) : '-'}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-border/50">
                  <td colSpan={3} className="text-right pt-0.5 text-[9px] text-tertiary">
                    {i18nService.t('authCreditsUnit')}/{tierUnitSuffix}
                  </td>
                </tr>
              </tfoot>
            </table>
          ) : (
            <table className="mt-2 w-full text-[10px] text-secondary border-collapse">
              <thead>
                <tr className="border-b border-border/50">
                  <th className="text-left font-medium py-0.5 pr-2">{i18nService.t('mediaTierSpecLabel')}</th>
                  <th className="text-right font-medium py-0.5">{i18nService.t('authCreditsUnit')}/{tierUnitSuffix}</th>
                </tr>
              </thead>
              <tbody>
                {tiers.map((tier, i) => (
                  <tr key={i}>
                    <td className="py-0.5 pr-2">{formatTierLabel(tier)}</td>
                    <td className="text-right py-0.5">{tierCredits(tier)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : hoveredModel.unitCredits != null && hoveredModel.unitCredits > 0 ? (
          <div className="mt-2 text-[11px] text-secondary">
            ({i18nService.t('modelCostMultiplierLabel')} {hoveredModel.unitCredits} {i18nService.t('authCreditsUnit')}/{unitLabel})
          </div>
        ) : null}
      </div>
    );
    return createPortal(card, document.body);
  };

  const currentModels = activeTab === 'image' ? mediaModels.image : mediaModels.video;

  const triggerIcon = (
    <MagicIcon className="h-5 w-5" />
  );

  const renderDropdownContent = () => {
    const handleTabSwitch = (tab: 'image' | 'video') => {
      setActiveTab(tab);
    };

    return (
      <>
        {/* Tabs */}
        <div className="border-b border-border/60 p-2">
          <div className="flex rounded-lg bg-surface-raised p-0.5" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'image'}
              onClick={() => handleTabSwitch('image')}
              className={`min-w-0 flex-1 rounded-md px-2 py-1.5 text-center text-[12px] font-medium leading-4 transition-colors ${
                activeTab === 'image'
                  ? 'bg-surface text-foreground shadow-sm'
                  : 'text-secondary hover:text-foreground'
              }`}
            >
              <span className="truncate">{i18nService.t('mediaImage')}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'video'}
              onClick={() => handleTabSwitch('video')}
              className={`min-w-0 flex-1 rounded-md px-2 py-1.5 text-center text-[12px] font-medium leading-4 transition-colors ${
                activeTab === 'video'
                  ? 'bg-surface text-foreground shadow-sm'
                  : 'text-secondary hover:text-foreground'
              }`}
            >
              <span className="truncate">{i18nService.t('mediaVideo')}</span>
            </button>
          </div>
        </div>

        {/* Model List: max-h-80 fits eight rows, so a typical list needs no scrollbar. */}
        <div className="max-h-80 overflow-y-auto px-1.5 py-1">
          {isLoading ? (
            <div className="px-2 py-3 text-center text-xs text-secondary">
              {i18nService.t('mediaLoadingModels')}
            </div>
          ) : currentModels.length === 0 ? (
            <div className="px-2 py-3 text-center text-xs text-secondary">
              <div>{i18nService.t('mediaNoModels')}</div>
              <button
                type="button"
                onClick={handleOpenProviderSettings}
                className="mt-2 text-[12px] text-primary hover:underline cursor-pointer transition-colors"
              >
                {i18nService.t('mediaConfigureModels')}
              </button>
            </div>
          ) : (
            currentModels.map((model) => {
              const isSelected = activeTab === 'image'
                ? (canonicalizeMediaModelId(selection?.imageModelId) === model.modelId
                  || (selection?.mode === 'image' && canonicalizeMediaModelId(selection?.modelId) === model.modelId))
                : (canonicalizeMediaModelId(selection?.videoModelId) === model.modelId
                  || (selection?.mode === 'video' && canonicalizeMediaModelId(selection?.modelId) === model.modelId));
              const priceLabel = activeTab === 'image' ? getModelPriceLabel(model) : null;
              // The model name takes the remaining width; the price sits in a
              // right-aligned column next to a fixed check slot.
              return (
                <button
                  key={model.modelId}
                  type="button"
                  onClick={() => handleSelect(activeTab, model)}
                  onMouseEnter={(e) => handleModelHover(model, e)}
                  onMouseLeave={handleModelHoverEnd}
                  className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-foreground transition-colors ${
                    isSelected ? 'bg-surface-raised' : 'hover:bg-surface-raised'
                  }`}
                >
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center [&_svg]:h-[18px] [&_svg]:w-[18px]">
                    {resolveMediaModelIcon(model)}
                  </span>
                  <span className="flex min-w-0 flex-1 items-center gap-1.5">
                    <span className={`min-w-0 truncate text-[13px] leading-5 ${isSelected ? 'font-medium' : 'font-normal'}`}>
                      {model.displayName}
                    </span>
                  </span>
                  {priceLabel && (
                    <span className="shrink-0 whitespace-nowrap text-[11px] leading-4 text-secondary tabular-nums">
                      {priceLabel}
                    </span>
                  )}
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                    {isSelected && <CheckIcon className="h-4 w-4 text-primary" strokeWidth={2.5} />}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </>
    );
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        onClick={() => setIsOpen(!isOpen)}
        className={`flex h-[34px] w-[34px] items-center justify-center rounded-lg transition-colors ${
          selection && selection.mode !== 'none'
            ? 'text-foreground hover:bg-surface-raised'
            : 'text-secondary hover:bg-surface-raised hover:text-foreground/80'
        } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
      >
        {triggerIcon}
      </button>

      {isOpen && (
        <div
          ref={dropdownRef}
          style={{ width: panelPlacement.width }}
          className={`absolute bottom-full ${panelPlacement.alignEnd ? 'right-0' : 'left-0'} z-50 mb-1 rounded-xl border border-border bg-surface shadow-popover overflow-hidden`}
        >
          {renderDropdownContent()}
        </div>
      )}
      {renderHoverCard()}
    </div>
  );
};

export default MediaModelPicker;
