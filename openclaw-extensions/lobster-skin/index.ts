import { Type } from '@sinclair/typebox';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';

import { isLobsterAiDesktopSessionKey } from './sessionKey';

/**
 * LobsterSkin plugin for OpenClaw.
 *
 * Registers `hiai_skin_manage`, the only agent-facing way to author an AI skin
 * pack. The tool forwards to the LobsterAI main process over the loopback
 * bridge, which owns the skin store, validates workflow membership, and keeps
 * the images themselves out of the agent's hands: the agent registers asset
 * files produced by the seedream skill, it never holds image bytes.
 */

type PluginConfig = {
  callbackUrl: string;
  secret: string;
  requestTimeoutMs: number;
};

type SkinToolRequest = {
  tool: string;
  args: Record<string, unknown>;
  context: {
    sessionKey: string;
    toolCallId: string;
  };
};

type SkinToolResponse = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
  details?: Record<string, unknown>;
};

const LOG_PREFIX = '[lobster-skin]';

const DEFAULT_TIMEOUT_MS = 30_000;

const SkinToolName = {
  Manage: 'hiai_skin_manage',
} as const;

const SkinManageAction = {
  CreateDraft: 'create_draft',
  RegisterAsset: 'register_asset',
  Status: 'status',
  Apply: 'apply',
  Deactivate: 'deactivate',
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return !!value && typeof value === 'object' && !Array.isArray(value);
};

const sanitizeSkinArgsForLog = (args: Record<string, unknown>): Record<string, unknown> => ({
  action: typeof args.action === 'string' ? args.action : '',
  skinId: typeof args.skinId === 'string' ? args.skinId : '',
  slot: typeof args.slot === 'string' ? args.slot : '',
  nameLength: typeof args.name === 'string' ? args.name.length : 0,
  baseThemeId: typeof args.baseThemeId === 'string' ? args.baseThemeId : '',
  hasSourcePath: typeof args.sourcePath === 'string' && args.sourcePath.length > 0,
});

const parsePluginConfig = (value: unknown): PluginConfig => {
  const raw = isRecord(value) ? value : {};
  return {
    callbackUrl: typeof raw.callbackUrl === 'string' ? raw.callbackUrl.trim() : '',
    secret: typeof raw.secret === 'string' ? raw.secret.trim() : '',
    requestTimeoutMs: typeof raw.requestTimeoutMs === 'number' ? raw.requestTimeoutMs : DEFAULT_TIMEOUT_MS,
  };
};

async function callSkinBridge(
  config: PluginConfig,
  request: SkinToolRequest,
): Promise<SkinToolResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);

  try {
    const response = await fetch(config.callbackUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-lobster-media-secret': config.secret,
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    const text = await response.text();

    if (!response.ok) {
      throw new Error(`Skin bridge HTTP ${response.status}: ${text.trim() || response.statusText}`);
    }

    if (!text.trim()) {
      return { content: [{ type: 'text', text: 'No response from server.' }], isError: true };
    }

    const parsed = JSON.parse(text);
    if (isRecord(parsed) && Array.isArray(parsed.content)) {
      return parsed as SkinToolResponse;
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(parsed, null, 2) }],
      details: isRecord(parsed) ? parsed as Record<string, unknown> : undefined,
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { content: [{ type: 'text', text: 'Skin operation timed out.' }], isError: true };
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

const SkinPresentationPaletteSchema = Type.Object({
  canvas: Type.String({ description: 'Cowork canvas color as #RRGGBB.' }),
  panel: Type.String({ description: 'Sidebar and prompt surface color as #RRGGBB.' }),
  panelRaised: Type.String({ description: 'Raised surface color as #RRGGBB.' }),
  accent: Type.String({ description: 'Primary decorative accent as #RRGGBB.' }),
  accentForeground: Type.String({ description: 'Readable foreground color on the accent as #RRGGBB.' }),
  accentAlt: Type.String({ description: 'Secondary decorative accent as #RRGGBB.' }),
  foreground: Type.String({ description: 'Primary readable text color as #RRGGBB.' }),
  muted: Type.String({ description: 'Secondary readable text color as #RRGGBB.' }),
  border: Type.String({ description: 'Subtle skin border color as #RRGGBB.' }),
}, { additionalProperties: false });

const SkinPresentationSchema = Type.Object({
  mode: Type.Literal('immersive_shell'),
  palette: SkinPresentationPaletteSchema,
  art: Type.Optional(Type.Object({
    focusX: Type.Number({ minimum: 0, maximum: 1, description: 'Horizontal backdrop focal point.' }),
    focusY: Type.Number({ minimum: 0, maximum: 1, description: 'Vertical backdrop focal point.' }),
  }, { additionalProperties: false })),
  effects: Type.Optional(Type.Object({
    particleDensity: Type.Union([
      Type.Literal('none'),
      Type.Literal('sparse'),
    ]),
  }, { additionalProperties: false })),
}, { additionalProperties: false });

const SkinManageSchema = Type.Union([
  Type.Object({
    action: Type.Literal(SkinManageAction.CreateDraft),
    name: Type.String({ description: 'User-visible skin name.' }),
    baseThemeId: Type.Optional(Type.String({
      description: 'Legacy compatibility metadata. It does not control the light or dark appearance inferred from presentation colors.',
    })),
    presentation: Type.Optional(SkinPresentationSchema),
  }, { additionalProperties: false }),
  Type.Object({
    action: Type.Literal(SkinManageAction.RegisterAsset),
    skinId: Type.String({ description: 'Skin draft ID returned by create_draft.' }),
    slot: Type.Union([
      Type.Literal('workspace.backdrop'),
      Type.Literal('home.emblem'),
    ], { description: 'Fixed skin asset slot.' }),
    sourcePath: Type.String({ description: 'Absolute path of the generated local image.' }),
  }),
  Type.Object({
    action: Type.Literal(SkinManageAction.Status),
    skinId: Type.String({ description: 'Skin draft ID returned by create_draft.' }),
  }),
  Type.Object({
    action: Type.Literal(SkinManageAction.Apply),
    skinId: Type.String({ description: 'Ready skin draft ID to activate.' }),
  }),
  Type.Object({
    action: Type.Literal(SkinManageAction.Deactivate),
  }),
], { description: 'Trusted desktop skin operation to perform.' });

const plugin = {
  id: 'lobster-skin',
  name: 'LobsterSkin',
  description: 'AI skin pack management tools powered by LobsterAI.',
  configSchema: {
    parse(value: unknown): PluginConfig {
      return parsePluginConfig(value);
    },
  },
  register(api: OpenClawPluginApi) {
    const config = parsePluginConfig(api.pluginConfig);
    if (!config.callbackUrl || !config.secret) {
      api.logger.info(`${LOG_PREFIX} skipped: callbackUrl or secret not configured.`);
      return;
    }

    api.registerTool((ctx) => {
      const sessionKey = ctx.sessionKey ?? '';
      if (!isLobsterAiDesktopSessionKey(sessionKey)) {
        return null;
      }

      return {
        name: SkinToolName.Manage,
        label: 'AI Skin Management',
        description: [
          'Create and manage a LobsterAI AI skin pack through the trusted desktop bridge.',
          'This tool manages drafts and assets; it does not generate images.',
          'Generate skin artwork with the seedream skill first, then register the resulting local files here.',
          'For a new pack, call create_draft with a name and an optional validated immersive-shell presentation first.',
          'LobsterAI deterministically infers a preferred light or dark appearance from presentation colors and applies it through the existing theme system; do not choose a color theme ID.',
          'Only allow-listed application and conversation title bars may use presentation colors. Page layout, system icons, and arbitrary CSS are never skin-controlled.',
          'The only supported asset slots are workspace.backdrop followed by home.emblem.',
          'Use register_asset with skinId, slot, and sourcePath after each generation succeeds.',
          'Use status to verify readiness and apply only after the draft is ready. Deactivating removes custom imagery and presentation styling while keeping the current color theme.',
        ].join(' '),
        parameters: SkinManageSchema,
        async execute(id: string, params: unknown) {
          const args = (params ?? {}) as Record<string, unknown>;
          const action = typeof args.action === 'string' ? args.action : '';
          try {
            api.logger.info(`${LOG_PREFIX} skin tool (${action}) started: toolCallId=${id} args=${JSON.stringify(sanitizeSkinArgsForLog(args))}`);
            const startedAt = Date.now();
            const result = await callSkinBridge(config, {
              tool: SkinToolName.Manage,
              args,
              context: { sessionKey, toolCallId: id },
            });
            api.logger.info(`${LOG_PREFIX} skin tool (${action}) completed: toolCallId=${id} elapsedMs=${Date.now() - startedAt} isError=${result.isError === true}`);
            return result;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            api.logger.info(`${LOG_PREFIX} skin tool (${action}) failed: toolCallId=${id} error=${message}`);
            return { content: [{ type: 'text', text: `Skin management failed: ${message}` }], isError: true };
          }
        },
      };
    });

    api.logger.info(`${LOG_PREFIX} registered hiai_skin_manage tool.`);
  },
};

export default plugin;
