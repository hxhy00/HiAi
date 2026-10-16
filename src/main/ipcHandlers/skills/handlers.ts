import { ipcMain } from 'electron';

import type {
  SkillInstallOrigin,
  SkillInstallOriginInput,
} from '../../../shared/skills/marketplaceSources';
import { fetchUnifiedMarketplace } from '../../libs/skillMarketplace';
import { updatePluginSkillIdsFromReport } from '../../skills';
import type { SkillManager } from '../../skills/skillManager';

export interface SkillHandlerDeps {
  getSkillManager: () => SkillManager;
  getOpenClawRuntimeAdapter: () => {
    connectGatewayIfNeeded: () => Promise<void>;
    getGatewayClient: () => {
      request: <T = Record<string, unknown>>(
        method: string,
        params?: unknown,
        opts?: { timeoutMs?: number },
      ) => Promise<T>;
    } | null;
  } | null;
}

export function registerSkillHandlers(deps: SkillHandlerDeps): void {
  const { getSkillManager, getOpenClawRuntimeAdapter } = deps;

  ipcMain.handle('skills:list', () => {
    try {
      const skills = getSkillManager().listSkills();
      return { success: true, skills };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to load skills' };
    }
  });

  ipcMain.handle('skills:setEnabled', async (_event, options: { id: string; enabled: boolean }) => {
    try {
      const skills = getSkillManager().setSkillEnabled(options.id, options.enabled);
      // Best-effort sync to OpenClaw
      try {
        const adapter = getOpenClawRuntimeAdapter();
        if (adapter) {
          await adapter.connectGatewayIfNeeded();
          const client = adapter.getGatewayClient();
          if (client) {
            await client.request('skills.update', { skillKey: options.id, enabled: options.enabled }, { timeoutMs: 10_000 });
          }
        }
      } catch (ocError) {
        console.warn('[skills] Failed to sync enabled state to OpenClaw:', ocError);
      }
      return { success: true, skills };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to update skill' };
    }
  });

  ipcMain.handle('skills:delete', async (_event, id: string) => {
    try {
      // Only the skill's own directory is removed. Files inside it come from the
      // installed package, so they must never name anything else to delete.
      const skills = await getSkillManager().deleteSkill(id);
      return { success: true, skills };
    } catch (error) {
      console.error('[skills] Failed to delete skill:', id, error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to delete skill' };
    }
  });

  ipcMain.handle('skills:download', async (_event, source: string, origin?: SkillInstallOriginInput) => {
    return getSkillManager().downloadSkill(source, origin);
  });

  ipcMain.handle('skills:upgrade', async (
    _event,
    skillId: string,
    downloadUrl: string,
    origin?: SkillInstallOriginInput,
  ) => {
    return getSkillManager().upgradeSkill(skillId, downloadUrl, origin);
  });

  ipcMain.handle('skills:listInstallOrigins', () => {
    try {
      return { success: true, origins: getSkillManager().listSkillInstallOrigins() };
    } catch (error) {
      return {
        success: false,
        origins: {} as Record<string, SkillInstallOrigin>,
        error: error instanceof Error ? error.message : 'Failed to load install origins',
      };
    }
  });

  ipcMain.handle('skills:confirmInstall', async (_event, pendingId: string, action: string) => {
    const validActions = ['install', 'installDisabled', 'cancel'];
    if (!validActions.includes(action)) {
      return { success: false, error: 'Invalid action' };
    }
    return getSkillManager().confirmPendingInstall(
      pendingId,
      action as 'install' | 'installDisabled' | 'cancel'
    );
  });

  ipcMain.handle('skills:getRoot', () => {
    try {
      const root = getSkillManager().getSkillsRoot();
      return { success: true, path: root };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to resolve skills root' };
    }
  });

  ipcMain.handle('skills:autoRoutingPrompt', () => {
    try {
      const prompt = getSkillManager().buildAutoRoutingPrompt();
      return { success: true, prompt };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to build auto-routing prompt' };
    }
  });

  ipcMain.handle('skills:getConfig', (_event, skillId: string) => {
    return getSkillManager().getSkillConfig(skillId);
  });

  ipcMain.handle('skills:setConfig', (_event, skillId: string, config: Record<string, string>) => {
    return getSkillManager().setSkillConfig(skillId, config);
  });

  ipcMain.handle('skills:getEmailAccountsConfig', (_event, skillId: string) => {
    return getSkillManager().getEmailAccountsConfig(skillId);
  });

  ipcMain.handle('skills:setEmailAccountsConfig', (_event, skillId: string, config: Parameters<SkillManager['setEmailAccountsConfig']>[1]) => {
    return getSkillManager().setEmailAccountsConfig(skillId, config);
  });

  ipcMain.handle('skills:testEmailAccountConnectivity', async (
    _event,
    skillId: string,
    account: Parameters<SkillManager['testEmailAccountConnectivity']>[1]
  ) => {
    return getSkillManager().testEmailAccountConnectivity(skillId, account);
  });

  ipcMain.handle('skills:testEmailConnectivity', async (
    _event,
    skillId: string,
    config: Record<string, string>
  ) => {
    return getSkillManager().testEmailConnectivity(skillId, config);
  });

  ipcMain.handle('skills:fetchMarketplace', async (
    _event,
    query?: { query?: string; limit?: number; cursor?: string },
  ) => {
    try {
      const result = await fetchUnifiedMarketplace(query ?? {});
      return {
        success: true,
        skills: result.skills,
        errors: result.errors,
        nextCursors: result.nextCursors,
        localSkills: result.localSkills,
      };
    } catch (error) {
      console.error('[SkillMarketplace] unified fetch failed:', error);
      return {
        success: false,
        skills: [] as unknown[],
        errors: {} as Record<string, string>,
        nextCursors: {} as Record<string, string>,
        localSkills: [] as unknown[],
        error: error instanceof Error ? error.message : 'Failed to fetch skill marketplace',
      };
    }
  });

  ipcMain.handle('skills:detectFromOpenClaw', async () => {
    try {
      const adapter = getOpenClawRuntimeAdapter();
      if (!adapter) {
        return { skills: [], error: 'OpenClaw runtime not available' };
      }
      await adapter.connectGatewayIfNeeded();
      const client = adapter.getGatewayClient();
      if (!client) {
        return { skills: [], error: 'Gateway client not connected' };
      }
      const report = await client.request<{ skills: Array<Record<string, unknown>> }>('skills.status', {}, { timeoutMs: 10_000 });
      const sm = getSkillManager();
      updatePluginSkillIdsFromReport(sm, report as any);
      return sm.detectSkillsFromOpenClaw(report as any);
    } catch (error) {
      return { skills: [], error: error instanceof Error ? error.message : 'Detection failed' };
    }
  });

  ipcMain.handle('skills:syncFromOpenClaw', async () => {
    try {
      const adapter = getOpenClawRuntimeAdapter();
      if (!adapter) {
        return { synced: [], error: 'OpenClaw runtime not available' };
      }
      await adapter.connectGatewayIfNeeded();
      const client = adapter.getGatewayClient();
      if (!client) {
        return { synced: [], error: 'Gateway client not connected' };
      }
      const report = await client.request<{ skills: Array<Record<string, unknown>> }>('skills.status', {}, { timeoutMs: 10_000 });
      const sm = getSkillManager();
      updatePluginSkillIdsFromReport(sm, report as any);
      return sm.syncSkillsFromOpenClaw(report as any);
    } catch (error) {
      return { synced: [], error: error instanceof Error ? error.message : 'Sync failed' };
    }
  });

  ipcMain.handle('skills:refreshPluginSkillIds', async () => {
    try {
      const adapter = getOpenClawRuntimeAdapter();
      if (!adapter) {
        return { success: false, error: 'OpenClaw runtime not available' };
      }
      await adapter.connectGatewayIfNeeded();
      const client = adapter.getGatewayClient();
      if (!client) {
        return { success: false, error: 'Gateway client not connected' };
      }
      const report = await client.request<{ skills: Array<Record<string, unknown>> }>('skills.status', {}, { timeoutMs: 10_000 });
      const sm = getSkillManager();
      updatePluginSkillIdsFromReport(sm, report as any);
      return { success: true, pluginSkillIds: [...sm.getPluginSkillIds()] };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Refresh failed' };
    }
  });
}
