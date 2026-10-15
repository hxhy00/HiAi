export const APP_NAME = 'HiAi';
export const APP_ID = 'hiai';

/**
 * Marker written into exported provider configs, and the password their API keys
 * are encrypted with.
 *
 * These were renamed along with the app. Exports are read back by exactly one
 * build of the app, so the old values are deliberately not accepted any more:
 * this is a clean cut, not a migration. A file exported before the rename has to
 * be re-exported.
 */
export const EXPORT_FORMAT_TYPE = 'hiai.providers';
export const EXPORT_PASSWORD = 'hiai-APP';