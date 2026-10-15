export const APP_NAME = 'HiAi';
export const APP_ID = 'hiai';
export const EXPORT_FORMAT_TYPE = 'hiai.providers';
export const EXPORT_PASSWORD = 'hiai-APP';

/**
 * Export marker and password used before the app was renamed.
 *
 * Both are only read, never written: exports always use the current values, but
 * a file exported before the update must still import. The format marker is
 * compared on import, and the password decrypts the per-provider API keys, so
 * dropping either would make every existing export unreadable.
 */
export const LEGACY_EXPORT_FORMAT_TYPE = 'lobsterai.providers';
export const LEGACY_EXPORT_PASSWORD = 'lobsterai-APP';

/** Format markers accepted on import, current first. */
export const ACCEPTED_EXPORT_FORMAT_TYPES: readonly string[] = [
  EXPORT_FORMAT_TYPE,
  LEGACY_EXPORT_FORMAT_TYPE,
];

/** Passwords tried when decrypting an imported file, current first. */
export const EXPORT_PASSWORD_CANDIDATES: readonly string[] = [
  EXPORT_PASSWORD,
  LEGACY_EXPORT_PASSWORD,
];
