/**
 * 集中管理所有业务 API 端点。
 * 后续新增的业务接口也应在此文件中配置。
 */

import { configService } from './config';

export const isTestModeEnabled = () => {
  return configService.getConfig().app?.testMode === true;
};

// 自动更新
export const getUpdateCheckUrl = () => isTestModeEnabled()
  ? 'https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/test/update'
  : 'https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/prod/update';

// 手动检查更新
export const getManualUpdateCheckUrl = () => isTestModeEnabled()
  ? 'https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/test/update-manual'
  : 'https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/prod/update-manual';

export const getFallbackDownloadUrl = () => isTestModeEnabled()
  ? 'https://lobsterai.inner.youdao.com/#/download-list'
  : 'https://lobsterai.youdao.com/#/download-list';

// Skill 商店
export const getSkillStoreUrl = () => isTestModeEnabled()
  ? 'https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/test/skill-store'
  : 'https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/prod/skill-store';

// Kit 商店
export const getKitStoreUrl = () => isTestModeEnabled()
  ? 'https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/test/kit-store'
  : 'https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/prod/kit-store';

// Portal 定价页（仅剩分享/部署的发布归因跳转使用）
const PORTAL_BASE_TEST = 'https://lobsterai.inner.youdao.com/portal#';
const PORTAL_BASE_PROD = 'https://lobsterai.youdao.com/portal#';

const getPortalBase = () => isTestModeEnabled() ? PORTAL_BASE_TEST : PORTAL_BASE_PROD;

export const PortalPricingKeyfrom = {
  HtmlShare: 'html_share',
  SiteDeployment: 'site_deployment',
} as const;

export type PortalPricingKeyfrom =
  (typeof PortalPricingKeyfrom)[keyof typeof PortalPricingKeyfrom];

export interface PortalPricingUrlOptions {
  traceId?: string;
}

export const getPortalPricingUrl = (
  keyfrom?: PortalPricingKeyfrom,
  options: PortalPricingUrlOptions = {},
) => {
  const query = new URLSearchParams();
  if (keyfrom) query.set('keyfrom', keyfrom);
  if (options.traceId) query.set('trace_id', options.traceId);
  const queryString = query.toString();
  const suffix = queryString ? `?${queryString}` : '';
  return `${getPortalBase()}/pricing${suffix}`;
};
