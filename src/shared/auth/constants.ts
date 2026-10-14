export const AuthRefreshOutcome = {
  NoTokens: 'no_tokens',
  Success: 'success',
  TerminalFailure: 'terminal_failure',
  TransientFailure: 'transient_failure',
} as const;

export type AuthRefreshOutcome = typeof AuthRefreshOutcome[keyof typeof AuthRefreshOutcome];

export type AuthTokenRefreshResult = {
  outcome: AuthRefreshOutcome;
  accessToken?: string;
};

export const AuthRefreshFailureKind = {
  Http: 'http_error',
  InvalidResponse: 'invalid_response',
  Network: 'network',
  Rejected: 'rejected',
  Timeout: 'timeout',
} as const;

export type AuthRefreshFailureKind =
  typeof AuthRefreshFailureKind[keyof typeof AuthRefreshFailureKind];

export const AuthRefreshReason = {
  CompatProxy: 'compat-proxy',
  Manual: 'manual',
  OpenClawProxy: 'openclaw-proxy',
  Passive: 'passive',
  Proactive: 'proactive',
} as const;

export type AuthRefreshReason = typeof AuthRefreshReason[keyof typeof AuthRefreshReason];
