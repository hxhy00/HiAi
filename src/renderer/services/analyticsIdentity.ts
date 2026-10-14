import {
  PublishingIdentityType,
  type PublishingIdentityType as PublishingIdentityTypeValue,
} from '@shared/publishing/constants';

export interface AnalyticsIdentitySnapshot {
  userId: string;
  isLoggedIn: boolean;
  identityType: PublishingIdentityTypeValue;
}

// Login capability was removed (remove-membership §11 D1): every analytics
// identity resolves to the anonymous free identity.
export const getAnalyticsIdentitySnapshot = (): AnalyticsIdentitySnapshot => ({
  userId: '',
  isLoggedIn: false,
  identityType: PublishingIdentityType.Free,
});
