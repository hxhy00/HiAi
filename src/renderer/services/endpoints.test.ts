import { afterEach, expect, test, vi } from 'vitest';

import { configService } from './config';
import {
  getPortalPricingUrl,
  PortalPricingKeyfrom,
} from './endpoints';

const mockTestMode = (testMode: boolean) => {
  vi.spyOn(configService, 'getConfig').mockReturnValue({
    app: { testMode },
  } as ReturnType<typeof configService.getConfig>);
};

afterEach(() => {
  vi.restoreAllMocks();
});

test('portal pricing url can include html share keyfrom', () => {
  mockTestMode(false);

  expect(getPortalPricingUrl(PortalPricingKeyfrom.HtmlShare)).toBe(
    'https://lobsterai.youdao.com/portal#/pricing?keyfrom=html_share',
  );
});

test('portal pricing url can carry a publishing attribution trace', () => {
  mockTestMode(false);

  expect(getPortalPricingUrl(
    PortalPricingKeyfrom.HtmlShare,
    { traceId: 'attempt-123' },
  )).toBe(
    'https://lobsterai.youdao.com/portal#/pricing?keyfrom=html_share&trace_id=attempt-123',
  );
});
