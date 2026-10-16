import { ENABLE_HTML_SHARE } from '@shared/featureFlags';

import { type Artifact, ArtifactTypeValue } from '@/types/artifact';

import { isArtifactFileShareable } from './artifactFileSharePolicy';

export const ArtifactToolbarPublishActionKind = {
  Share: 'share',
} as const;

export type ArtifactToolbarPublishActionKind =
  (typeof ArtifactToolbarPublishActionKind)[keyof typeof ArtifactToolbarPublishActionKind];

export interface ArtifactToolbarShareTarget {
  kind: typeof ArtifactToolbarPublishActionKind.Share;
  artifact: Artifact;
}

export type ArtifactToolbarPublishTarget = ArtifactToolbarShareTarget;

export function resolveArtifactPreviewToolbarPublishTarget(
  artifact: Artifact | null | undefined,
  shareAvailable: boolean,
): ArtifactToolbarShareTarget | null {
  if (!ENABLE_HTML_SHARE) return null;
  if (!shareAvailable || !artifact || !isArtifactFileShareable(artifact)) return null;
  return {
    kind: ArtifactToolbarPublishActionKind.Share,
    artifact,
  };
}

export function resolveBrowserToolbarPublishTarget(input: {
  htmlArtifact?: Artifact | null;
  shareAvailable: boolean;
}): ArtifactToolbarPublishTarget | null {
  // Managed HTML previews use an internal loopback preview server. Preserve
  // the Artifact identity instead of mistaking that server for a deployable app.
  if (!input.htmlArtifact) return null;
  if (input.htmlArtifact.type !== ArtifactTypeValue.Html) return null;
  return resolveArtifactPreviewToolbarPublishTarget(
    input.htmlArtifact,
    input.shareAvailable,
  );
}
