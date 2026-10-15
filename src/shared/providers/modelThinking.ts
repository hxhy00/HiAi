export const ModelThinkingLevel = {
  Off: 'off',
  Minimal: 'minimal',
  Low: 'low',
  Medium: 'medium',
  High: 'high',
  XHigh: 'xhigh',
  Max: 'max',
} as const;

export type ModelThinkingLevel =
  typeof ModelThinkingLevel[keyof typeof ModelThinkingLevel];

export const OpenClawThinkingLevel = {
  Off: 'off',
  Minimal: 'minimal',
  Low: 'low',
  Medium: 'medium',
  High: 'high',
  XHigh: 'xhigh',
} as const;

export type OpenClawThinkingLevel =
  typeof OpenClawThinkingLevel[keyof typeof OpenClawThinkingLevel];

export interface ModelThinkingOption {
  level: ModelThinkingLevel;
  openclawLevel: OpenClawThinkingLevel;
}

export interface ModelThinkingConfig {
  options: ModelThinkingOption[];
  defaultLevel: ModelThinkingLevel;
}

const MODEL_THINKING_LEVEL_VALUES = new Set<string>(
  Object.values(ModelThinkingLevel),
);
const OPENCLAW_THINKING_LEVEL_VALUES = new Set<string>(
  Object.values(OpenClawThinkingLevel),
);

export const parseModelThinkingLevel = (
  value: unknown,
): ModelThinkingLevel | undefined => (
  typeof value === 'string' && MODEL_THINKING_LEVEL_VALUES.has(value)
    ? value as ModelThinkingLevel
    : undefined
);

export const parseOpenClawThinkingLevel = (
  value: unknown,
): OpenClawThinkingLevel | undefined => (
  typeof value === 'string' && OPENCLAW_THINKING_LEVEL_VALUES.has(value)
    ? value as OpenClawThinkingLevel
    : undefined
);

export const parseModelThinkingConfig = (
  value: unknown,
): ModelThinkingConfig | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;
  if (!Array.isArray(candidate.options) || candidate.options.length === 0) {
    return undefined;
  }

  const options: ModelThinkingOption[] = [];
  const seenLevels = new Set<ModelThinkingLevel>();
  const seenOpenClawLevels = new Set<OpenClawThinkingLevel>();
  for (const rawOption of candidate.options) {
    if (!rawOption || typeof rawOption !== 'object' || Array.isArray(rawOption)) {
      return undefined;
    }
    const option = rawOption as Record<string, unknown>;
    const level = parseModelThinkingLevel(option.level);
    const openclawLevel = parseOpenClawThinkingLevel(option.openclawLevel);
    if (
      !level
      || !openclawLevel
      || seenLevels.has(level)
      || seenOpenClawLevels.has(openclawLevel)
      || (level === ModelThinkingLevel.Off) !== (openclawLevel === OpenClawThinkingLevel.Off)
    ) {
      return undefined;
    }
    seenLevels.add(level);
    seenOpenClawLevels.add(openclawLevel);
    options.push({ level, openclawLevel });
  }
  if (options.length === 1 && options[0]?.level === ModelThinkingLevel.Off) {
    return undefined;
  }

  const defaultLevel = parseModelThinkingLevel(candidate.defaultLevel);
  if (!defaultLevel || !seenLevels.has(defaultLevel)) {
    return undefined;
  }

  return { options, defaultLevel };
};

// 用户自配 provider 只有布尔 `supportsThinking` 开关，没有服务端下发的
// `thinkingConfig`。这里按通用 OpenAI 兼容档位合成声明：off / low / medium /
// high，默认 medium。档位值须落在 OpenClaw 认可的原生推理档位集合内
// （minimal|low|medium|high|xhigh|max|ultra）。
// 缺少该声明时，生成的 OpenClaw 配置只有 `reasoning: true`，网关不会产生
// `stream=thinking` 事件，前端拿不到思考内容。
const CUSTOM_MODEL_THINKING_OPTIONS: ModelThinkingOption[] = [
  { level: ModelThinkingLevel.Off, openclawLevel: OpenClawThinkingLevel.Off },
  { level: ModelThinkingLevel.Low, openclawLevel: OpenClawThinkingLevel.Low },
  { level: ModelThinkingLevel.Medium, openclawLevel: OpenClawThinkingLevel.Medium },
  { level: ModelThinkingLevel.High, openclawLevel: OpenClawThinkingLevel.High },
];

export const buildCustomModelThinkingConfig = (
  supportsThinking: boolean | undefined,
): ModelThinkingConfig | undefined => {
  if (supportsThinking !== true) return undefined;
  return {
    options: CUSTOM_MODEL_THINKING_OPTIONS.map(option => ({ ...option })),
    defaultLevel: ModelThinkingLevel.Medium,
  };
};

export const getModelThinkingLevels = (
  config: ModelThinkingConfig,
): ModelThinkingLevel[] => config.options.map(option => option.level);

export const resolveOpenClawThinkingLevel = (
  config: ModelThinkingConfig,
  level: ModelThinkingLevel,
): OpenClawThinkingLevel | undefined => (
  config.options.find(option => option.level === level)?.openclawLevel
);

export const resolveProductThinkingLevel = (
  config: ModelThinkingConfig,
  openclawLevel: OpenClawThinkingLevel,
): ModelThinkingLevel | undefined => (
  config.options.find(option => option.openclawLevel === openclawLevel)?.level
);
