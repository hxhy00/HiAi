export const APP_NAME = 'HiAi';
export const APP_ID = 'lobsterai';
export const APP_USER_MODEL_ID = 'com.lobsterai.app';
export const APP_ATTENTION_BADGE_COLOR = '#FF3B30';
export const DB_FILENAME = 'hiai.sqlite';

/**
 * SQLite file name used before the app was renamed. The profile migration moves
 * the whole directory but not individual file names, so this rename has to be
 * carried out explicitly — otherwise the app would open a brand new database and
 * every setting would look lost again.
 */
export const LEGACY_DB_FILENAME = 'lobsterai.sqlite';

/**
 * Profile directory name used before the app was renamed. Kept only so
 * `migrateLegacyUserDataDir` can move an existing install's data on first
 * launch; never use it for new paths.
 */
export const LEGACY_APP_DIR_NAME = 'LobsterAI';
