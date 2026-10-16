/**
 * 集中管理所有业务 API 端点。
 * 后续新增的业务接口也应在此文件中配置。
 *
 * Update checks, the skill store and the kit store are resolved in the main
 * process (see `src/main/libs/endpoints.ts`); this file only carries the
 * renderer-side URLs that the UI opens directly.
 */

import { configService } from './config';

export const isTestModeEnabled = () => {
  return configService.getConfig().app?.testMode === true;
};

// Portal 定价页（仅剩分享/部署的发布归因跳转使用）
const PORTAL_BASE_TEST = 'https://lobsterai.inner.youdao.com/portal#';
const PORTAL_BASE_PROD = 'https://lobsterai.youdao.com/portal#';

const getPortalBase = () => isTestModeEnabled() ? PORTAL_BASE_TEST : PORTAL_BASE_PROD;

export const PortalPricingKeyfrom = {
  HtmlShare: 'html_share',
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
