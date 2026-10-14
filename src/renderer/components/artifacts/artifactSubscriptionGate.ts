export const ArtifactSubscriptionFeature = {
  Share: 'share',
  Deployment: 'deployment',
} as const;

export type ArtifactSubscriptionFeature =
  (typeof ArtifactSubscriptionFeature)[keyof typeof ArtifactSubscriptionFeature];

// Login capability was removed (remove-membership §11 D1): sharing and
// deployment are entry-gated upstream and the server enforces any remaining
// quotas, so there is no client-side entitlement decision anymore. The feature
// constants survive only because publishing analytics still tags which feature
// an action belongs to.
