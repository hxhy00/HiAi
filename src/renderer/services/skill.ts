import type {
  SkillInstallOrigin,
  SkillInstallOriginInput,
} from '../../shared/skills/marketplaceSources';
import { BUNDLED_SKILL_DISPLAY_NAMES } from '../components/skills/bundledSkillNames';
import { LocalizedText, LocalSkillInfo, MarketplaceSkill, Skill } from '../types/skill';
import { i18nService } from './i18n';

/** How long an aggregated marketplace result stays fresh before a refetch. */
export const MARKETPLACE_CACHE_TTL_MS = 10 * 60 * 1000;

/** Cache key for a marketplace query; empty term and explicit limit collapse. */
function normalizeMarketplaceQueryKey(query: { query?: string; limit?: number }): string {
  return `${(query.query ?? '').trim().toLowerCase()}|${query.limit ?? ''}`;
}


export function resolveLocalizedText(text: string | LocalizedText): string {
  if (!text) return '';
  if (typeof text === 'string') return text;
  const lang = i18nService.getLanguage();
  return text[lang] || text.en || '';
}

/** Segments that should stay uppercase instead of becoming `Hr` / `Ai`. */
const SKILL_NAME_ACRONYMS = new Set([
  'ai', 'api', 'cli', 'csv', 'hr', 'html', 'im', 'json',
  'pdf', 'ppt', 'qq', 'seo', 'sql', 'ui', 'url',
]);

/**
 * Turn an id-style skill name into something readable:
 * `canvas-design` → `Canvas Design`, `hr-recruitment` → `HR Recruitment`.
 * Names that already look like a title (contain spaces or non-ASCII
 * characters) are returned untouched.
 */
export function prettifySkillName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return trimmed;
  const hasNonAscii = Array.from(trimmed).some(char => char.charCodeAt(0) > 127);
  if (hasNonAscii || /\s/.test(trimmed)) return trimmed;
  return trimmed
    .split(/[-_.]+/)
    .filter(Boolean)
    .map(part => (
      SKILL_NAME_ACRONYMS.has(part.toLowerCase())
        ? part.toUpperCase()
        : part.charAt(0).toUpperCase() + part.slice(1)
    ))
    .join(' ');
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(s => parseInt(s, 10) || 0);
  const pb = b.split('.').map(s => parseInt(s, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

type EmailConnectivityCheck = {
  code: 'imap_connection' | 'smtp_connection';
  level: 'pass' | 'fail';
  message: string;
  durationMs: number;
};

type EmailConnectivityTestResult = {
  testedAt: number;
  verdict: 'pass' | 'fail';
  checks: EmailConnectivityCheck[];
};

export type EmailSkillAccountConfig = {
  id: string;
  name: string;
  enabled: boolean;
  provider?: string;
  email: string;
  password?: string;
  imapHost?: string;
  imapPort?: number;
  imapTls?: boolean;
  imapRejectUnauthorized?: boolean;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpRejectUnauthorized?: boolean;
  smtpFrom?: string;
  mailbox?: string;
  requireSendConfirmation?: boolean;
};

export type EmailSkillAccountsConfig = {
  version: 1;
  defaultAccountId: string;
  accounts: EmailSkillAccountConfig[];
};

class SkillService {
  private skills: Skill[] = [];
  private initialized = false;
  private localSkillDescriptions: Map<string, string | LocalizedText> = new Map();
  private marketplaceSkillDescriptions: Map<string, string | LocalizedText> = new Map();
  private installedKitSkillDescriptions: Map<string, string | LocalizedText> = new Map();
  private localSkillNames: Map<string, string | LocalizedText> = new Map();
  private marketplaceSkillNames: Map<string, string | LocalizedText> = new Map();
  private installedKitSkillNames: Map<string, string | LocalizedText> = new Map();
  private skillIcons: Map<string, string> = new Map();
  private marketplaceCache: Map<string, { skills: MarketplaceSkill[]; fetchedAt: number }> = new Map();
  private marketplaceFetchPromises: Map<string, Promise<MarketplaceSkill[]>> = new Map();
  private marketplaceErrors: Record<string, string> = {};
  private installOrigins: Record<string, SkillInstallOrigin> | null = null;
  private installOriginsPromise: Promise<Record<string, SkillInstallOrigin>> | null = null;

  async init(): Promise<void> {
    if (this.initialized) return;
    await this.loadSkills();
    this.initialized = true;
  }

  async loadSkills(): Promise<Skill[]> {
    try {
      const result = await window.electron.skills.list();
      if (result.success && result.skills) {
        this.skills = result.skills;
      } else {
        this.skills = [];
      }
      await this.loadInstalledKitSkillDescriptions();
      return this.skills;
    } catch (error) {
      console.error('Failed to load skills:', error);
      this.skills = [];
      return this.skills;
    }
  }

  async setSkillEnabled(id: string, enabled: boolean): Promise<Skill[]> {
    try {
      const result = await window.electron.skills.setEnabled({ id, enabled });
      if (result.success && result.skills) {
        this.skills = result.skills;
        return this.skills;
      }
      throw new Error(result.error || 'Failed to update skill');
    } catch (error) {
      console.error('Failed to update skill:', error);
      throw error;
    }
  }

  async deleteSkill(id: string): Promise<{ success: boolean; skills?: Skill[]; error?: string }> {
    try {
      const result = await window.electron.skills.delete(id);
      if (result.success && result.skills) {
        this.skills = result.skills;
        if (this.installOrigins) {
          await this.refreshInstallOrigins();
        }
        await this.refreshMarketplaceAfterInstall();
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to delete skill';
      console.error('Failed to delete skill:', error);
      return { success: false, error: message };
    }
  }

  async downloadSkill(source: string, origin?: SkillInstallOriginInput): Promise<{
    success: boolean;
    skills?: Skill[];
    error?: string;
    auditReport?: any;
    pendingInstallId?: string;
  }> {
    try {
      const result = await window.electron.skills.download(source, origin);
      if (result.success && result.skills) {
        this.skills = result.skills;
        // A pending install still awaits confirmation; its origin is only real
        // once confirmed, and so is the "installed" state of its market row.
        if (!result.pendingInstallId) {
          await this.refreshInstallOrigins();
          await this.refreshMarketplaceAfterInstall();
        }
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to download skill';
      console.error('Failed to download skill:', error);
      return { success: false, error: message };
    }
  }

  async confirmInstall(
    pendingId: string,
    action: string
  ): Promise<{ success: boolean; skills?: Skill[]; error?: string }> {
    try {
      const result = await window.electron.skills.confirmInstall(pendingId, action);
      if (result.success && result.skills) {
        this.skills = result.skills;
        await this.refreshInstallOrigins();
        await this.refreshMarketplaceAfterInstall();
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to confirm install';
      console.error('Failed to confirm install:', error);
      return { success: false, error: message };
    }
  }

  async upgradeSkill(skillId: string, downloadUrl: string, origin?: SkillInstallOriginInput): Promise<{
    success: boolean;
    skills?: Skill[];
    error?: string;
    auditReport?: any;
    pendingInstallId?: string;
  }> {
    try {
      const result = await window.electron.skills.upgrade(skillId, downloadUrl, origin);
      if (result.success && result.skills) {
        this.skills = result.skills;
        if (!result.pendingInstallId) {
          await this.refreshInstallOrigins();
          // The market row shows the installed version, so it must not keep the
          // pre-upgrade one.
          await this.refreshMarketplaceAfterInstall();
        }
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to upgrade skill';
      console.error('Failed to upgrade skill:', error);
      return { success: false, error: message };
    }
  }

  /**
   * Installed skill id to marketplace origin. Entries are missing for skills
   * installed before origins were recorded; callers fall back to plain id
   * matching in that case.
   */
  async loadInstallOrigins(force = false): Promise<Record<string, SkillInstallOrigin>> {
    if (!force && this.installOrigins) {
      return this.installOrigins;
    }
    if (!force && this.installOriginsPromise) {
      return this.installOriginsPromise;
    }
    this.installOriginsPromise = window.electron.skills
      .listInstallOrigins()
      .then(result => (result.success && result.origins ? result.origins : {}))
      .catch(error => {
        console.error('Failed to load skill install origins:', error);
        return {} as Record<string, SkillInstallOrigin>;
      })
      .then(origins => {
        this.installOrigins = origins;
        this.installOriginsPromise = null;
        return origins;
      });
    return this.installOriginsPromise;
  }

  private async refreshInstallOrigins(): Promise<void> {
    await this.loadInstallOrigins(true);
  }

  /**
   * Drop the aggregated marketplace cache.
   *
   * `marketplaceErrors` goes with it: it describes the load that produced the
   * cached rows, so keeping it after a refresh would surface a stale failure
   * next to a list that no longer matches it.
   */
  private invalidateMarketplaceCache(): void {
    this.marketplaceCache.clear();
    this.marketplaceErrors = {};
  }

  /**
   * An installed/removed skill is resolved against the marketplace list, so the
   * rows go stale the moment the installed set changes. The view is showing the
   * cached rows, so refresh them in place; failing that, drop the cache and let
   * the next read refetch.
   */
  private async refreshMarketplaceAfterInstall(): Promise<void> {
    const pending = [...this.marketplaceFetchPromises.values()];
    if (pending.length > 0) {
      try {
        await Promise.all(pending);
      } catch {
        // The list is already cached; a failed load leaves the previous rows.
      }
    }
    this.invalidateMarketplaceCache();
    try {
      await this.fetchMarketplaceSkills();
    } catch {
      // Nothing rendered depends on this Promise; the cache is dropped either way.
    }
  }

  async getSkillsRoot(): Promise<string | null> {
    try {
      const result = await window.electron.skills.getRoot();
      if (result.success && result.path) {
        return result.path;
      }
      return null;
    } catch (error) {
      console.error('Failed to get skills root:', error);
      return null;
    }
  }

  onSkillsChanged(callback: () => void): () => void {
    return window.electron.skills.onChanged(callback);
  }

  getSkills(): Skill[] {
    return this.skills;
  }

  getEnabledSkills(): Skill[] {
    return this.skills.filter(s => s.enabled);
  }

  getSkillById(id: string): Skill | undefined {
    return this.skills.find(s => s.id === id);
  }

  async getSkillConfig(skillId: string): Promise<Record<string, string>> {
    try {
      const result = await window.electron.skills.getConfig(skillId);
      if (result.success && result.config) {
        return result.config;
      }
      return {};
    } catch (error) {
      console.error('Failed to get skill config:', error);
      return {};
    }
  }

  async setSkillConfig(skillId: string, config: Record<string, string>): Promise<boolean> {
    try {
      const result = await window.electron.skills.setConfig(skillId, config);
      return result.success;
    } catch (error) {
      console.error('Failed to set skill config:', error);
      return false;
    }
  }

  async testEmailConnectivity(
    skillId: string,
    config: Record<string, string>
  ): Promise<EmailConnectivityTestResult | null> {
    try {
      const result = await window.electron.skills.testEmailConnectivity(skillId, config);
      if (result.success && result.result) {
        return result.result;
      }
      return null;
    } catch (error) {
      console.error('Failed to test email connectivity:', error);
      return null;
    }
  }

  async getEmailAccountsConfig(skillId: string): Promise<EmailSkillAccountsConfig> {
    try {
      console.debug('[EmailSkill] loading email accounts config', { skillId });
      const result = await window.electron.skills.getEmailAccountsConfig(skillId);
      if (result.success && result.config) {
        console.debug('[EmailSkill] loaded email accounts config', {
          skillId,
          accountCount: result.config.accounts.length,
          enabledAccountCount: result.config.accounts.filter(account => account.enabled).length,
          defaultAccountId: result.config.defaultAccountId,
        });
        return result.config;
      }
      console.warn('[EmailSkill] failed to load email accounts config', { skillId, error: result.error });
      return { version: 1, defaultAccountId: '', accounts: [] };
    } catch (error) {
      console.error('Failed to get email accounts config:', error);
      return { version: 1, defaultAccountId: '', accounts: [] };
    }
  }

  async setEmailAccountsConfig(
    skillId: string,
    config: EmailSkillAccountsConfig,
  ): Promise<boolean> {
    try {
      console.debug('[EmailSkill] saving email accounts config', {
        skillId,
        accountCount: config.accounts.length,
        enabledAccountCount: config.accounts.filter(account => account.enabled).length,
        defaultAccountId: config.defaultAccountId,
      });
      const result = await window.electron.skills.setEmailAccountsConfig(skillId, config);
      if (!result.success) {
        console.warn('[EmailSkill] failed to save email accounts config', { skillId, error: result.error });
      }
      return result.success;
    } catch (error) {
      console.error('Failed to set email accounts config:', error);
      return false;
    }
  }

  async testEmailAccountConnectivity(
    skillId: string,
    account: EmailSkillAccountConfig,
  ): Promise<EmailConnectivityTestResult | null> {
    try {
      console.debug('[EmailSkill] testing email account connectivity', {
        skillId,
        accountId: account.id,
        hasEmail: Boolean(account.email),
        hasPassword: Boolean(account.password),
        hasImapHost: Boolean(account.imapHost),
        hasSmtpHost: Boolean(account.smtpHost),
      });
      const result = await window.electron.skills.testEmailAccountConnectivity(skillId, account);
      if (result.success && result.result) {
        console.debug('[EmailSkill] email account connectivity test completed', {
          skillId,
          accountId: account.id,
          verdict: result.result.verdict,
        });
        return result.result;
      }
      console.warn('[EmailSkill] email account connectivity test failed', {
        skillId,
        accountId: account.id,
        error: result.error,
      });
      return null;
    } catch (error) {
      console.error('Failed to test email account connectivity:', error);
      return null;
    }
  }

  async getAutoRoutingPrompt(): Promise<string | null> {
    try {
      const result = await window.electron.skills.autoRoutingPrompt();
      return result.success ? (result.prompt || null) : null;
    } catch (error) {
      console.error('Failed to get auto-routing prompt:', error);
      return null;
    }
  }
  hasLocalizedSkillDescriptions(): boolean {
    return this.localSkillDescriptions.size > 0
      || this.marketplaceSkillDescriptions.size > 0
      || this.installedKitSkillDescriptions.size > 0;
  }

  /**
   * Aggregated marketplace list (first-party store + third-party registries).
   *
   * Results are cached per query for `MARKETPLACE_CACHE_TTL_MS` so re-entering
   * the tab renders instantly; concurrent callers share one request. Pass
   * `forceRefresh` to bypass the cache (the manual refresh button).
   */
  async fetchMarketplaceSkills(
    query: { query?: string; limit?: number } = {},
    forceRefresh = false,
  ): Promise<MarketplaceSkill[]> {
    const key = normalizeMarketplaceQueryKey(query);
    const cached = this.marketplaceCache.get(key);
    if (cached && !forceRefresh && Date.now() - cached.fetchedAt < MARKETPLACE_CACHE_TTL_MS) {
      return cached.skills;
    }
    const inFlight = this.marketplaceFetchPromises.get(key);
    if (inFlight) return inFlight;

    const promise = this.loadMarketplaceSkills(key, query)
      .finally(() => {
        this.marketplaceFetchPromises.delete(key);
      });
    this.marketplaceFetchPromises.set(key, promise);
    return promise;
  }

  /** Cached list without triggering a request; used for stale-while-revalidate. */
  getCachedMarketplaceSkills(query: { query?: string; limit?: number } = {}): MarketplaceSkill[] | null {
    const cached = this.marketplaceCache.get(normalizeMarketplaceQueryKey(query));
    if (!cached) return null;
    return Date.now() - cached.fetchedAt < MARKETPLACE_CACHE_TTL_MS ? cached.skills : null;
  }

  /** Whether a background refresh is worthwhile (cache exists but went stale). */
  hasStaleMarketplaceSkills(query: { query?: string; limit?: number } = {}): boolean {
    const cached = this.marketplaceCache.get(normalizeMarketplaceQueryKey(query));
    if (!cached) return false;
    return Date.now() - cached.fetchedAt >= MARKETPLACE_CACHE_TTL_MS;
  }

  private async loadMarketplaceSkills(
    key: string,
    query: { query?: string; limit?: number },
  ): Promise<MarketplaceSkill[]> {
    try {
      const result = await window.electron.skills.fetchMarketplace(query);
      if (!result.success) {
        throw new Error(result.error || 'Failed to fetch');
      }
      const skills: MarketplaceSkill[] = result.skills ?? [];
      const sourceErrors = result.errors ?? {};
      const failedSources = Object.keys(sourceErrors);
      if (failedSources.length > 0) {
        // Partial outage: show what loaded, but keep the reason visible.
        console.error('[SkillMarketplace] sources failed:', sourceErrors);
        this.marketplaceErrors = sourceErrors;
      } else {
        this.marketplaceErrors = {};
      }
      this.absorbLocalSkillMetadata(result.localSkills ?? []);
      this.absorbMarketplaceLocalization(skills);
      this.marketplaceCache.set(key, { skills, fetchedAt: Date.now() });
      return skills;
    } catch (error) {
      console.error('Failed to fetch marketplace skills:', error);
      const message = error instanceof Error ? error.message : String(error);
      this.marketplaceErrors = { ...this.marketplaceErrors, youdao: message };
      const cached = this.marketplaceCache.get(key);
      // Keep the last good list on a transient failure instead of blanking the tab.
      return cached ? cached.skills : [];
    }
  }

  /** Per-source errors from the last load, for the UI to surface. */
  getMarketplaceErrors(): Record<string, string> {
    return this.marketplaceErrors;
  }

  /**
   * Localized names/descriptions for skills already installed. Filled from the
   * same store response as the marketplace list, so the skill picker can render
   * zh/en text without a second request.
   */
  private absorbLocalSkillMetadata(localSkills: LocalSkillInfo[]): void {
    this.localSkillDescriptions.clear();
    this.localSkillNames.clear();
    this.skillIcons.clear();
    for (const ls of localSkills) {
      if (ls.description != null) {
        this.localSkillDescriptions.set(ls.name, ls.description);
        this.localSkillDescriptions.set(ls.id, ls.description);
      }
      if (ls.displayName != null) {
        this.localSkillNames.set(ls.name, ls.displayName);
        this.localSkillNames.set(ls.id, ls.displayName);
      }
      if (ls.icon) this.skillIcons.set(ls.id, ls.icon);
    }
  }

  private absorbMarketplaceLocalization(skills: MarketplaceSkill[]): void {
    this.marketplaceSkillDescriptions.clear();
    this.marketplaceSkillNames.clear();
    for (const ms of skills) {
      if (ms.description && typeof ms.description === 'object') {
        this.marketplaceSkillDescriptions.set(ms.id, ms.description);
      }
      if (ms.displayName != null) {
        this.marketplaceSkillNames.set(ms.id, ms.displayName);
      }
      if (ms.icon) this.skillIcons.set(ms.id, ms.icon);
    }
  }

  private async loadInstalledKitSkillDescriptions(): Promise<void> {
    this.installedKitSkillDescriptions.clear();
    try {
      const result = await window.electron.kits.listInstalled();
      if (!result.success || !result.installed) return;

      for (const kit of Object.values(result.installed)) {
        const metadata = kit.skills?.metadata ?? {};
        for (const [skillId, skillMetadata] of Object.entries(metadata)) {
          if (skillMetadata.description != null) {
            this.installedKitSkillDescriptions.set(skillId, skillMetadata.description);
          }
          if (skillMetadata.name != null) {
            this.installedKitSkillNames.set(skillId, skillMetadata.name);
          }
        }
      }
    } catch (error) {
      console.error('Failed to load installed kit skill descriptions:', error);
    }
  }

  /**
   * Resolve a human-friendly skill title. Order of preference:
   * server `displayName` (local → marketplace → kit) → bundled name map →
   * prettified raw name (`canvas-design` → `Canvas Design`).
   */
  getLocalizedSkillName(skillId: string, skillName: string): string {
    const serverName = this.localSkillNames.get(skillName)
      ?? this.localSkillNames.get(skillId)
      ?? this.marketplaceSkillNames.get(skillId)
      ?? this.installedKitSkillNames.get(skillId);
    if (serverName != null) return resolveLocalizedText(serverName);

    const bundled = BUNDLED_SKILL_DISPLAY_NAMES[skillId];
    if (bundled) return resolveLocalizedText(bundled);

    return prettifySkillName(skillName);
  }

  /** Server-provided icon URL, if any. Callers fall back to a generated tile. */
  getSkillIcon(skillId: string): string | undefined {
    return this.skillIcons.get(skillId);
  }

  getLocalizedSkillDescription(skillId: string, skillName: string, fallback: string): string {
    const localDesc = this.localSkillDescriptions.get(skillName) ?? this.localSkillDescriptions.get(skillId);
    if (localDesc != null) return resolveLocalizedText(localDesc);
    const marketDesc = this.marketplaceSkillDescriptions.get(skillId);
    if (marketDesc != null) return resolveLocalizedText(marketDesc);
    const kitDesc = this.installedKitSkillDescriptions.get(skillId);
    if (kitDesc != null) return resolveLocalizedText(kitDesc);
    return fallback;
  }
}

export const skillService = new SkillService();
