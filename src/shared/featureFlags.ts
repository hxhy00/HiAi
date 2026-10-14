/**
 * Feature flags for controlling experimental or incomplete features.
 * Toggle these to enable/disable features globally.
 */

/**
 * Whether to enable OpenClaw skill sync (auto-detect + manual sync entry).
 * Deleting a synced skill only removes LobsterAI's copy, so the next sync
 * imports it again; handle that before turning this back on.
 */
export const ENABLE_OPENCLAW_SKILL_SYNC = false;

/**
 * Whether to expose HTML artifact sharing.
 *
 * Sharing uploads artifacts to the LobsterAI server (`/api/html-shares`). The
 * app is now fully offline / personal-use, so the server is unreachable and
 * the entry points must stay hidden. The share service layer is intentionally
 * kept (see FR-4.4) so the feature can be revived later by flipping this flag.
 */
export const ENABLE_HTML_SHARE = false;

/**
 * Whether to expose site deployment.
 *
 * Deployment targets the LobsterAI server (`shareDeploymentClient` / `siteClient`).
 * Same reasoning as ENABLE_HTML_SHARE: hide the entry points, keep the service
 * layer. See FR-4.3 / FR-4.4.
 */
export const ENABLE_SITE_DEPLOYMENT = false;
