import { beforeEach, describe, expect, test, vi } from 'vitest';

import { type Artifact, ArtifactTypeValue } from '@/types/artifact';

import {
  ArtifactToolbarPublishActionKind,
  resolveArtifactPreviewToolbarPublishTarget,
  resolveBrowserToolbarPublishTarget,
} from './artifactToolbarPublishPolicy';

vi.mock('@shared/featureFlags', () => ({
  ENABLE_HTML_SHARE: true,
}));

const makeArtifact = (
  type: Artifact['type'],
  overrides: Partial<Artifact> = {},
): Artifact => ({
  id: 'artifact-1',
  messageId: 'message-1',
  sessionId: 'session-1',
  type,
  title: 'Artifact title',
  content: '',
  createdAt: 1,
  ...overrides,
});

describe('artifactToolbarPublishPolicy (features enabled)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  test('shares a shareable Artifact in the regular preview toolbar', () => {
    const artifact = makeArtifact(ArtifactTypeValue.Image, {
      filePath: '/tmp/image.png',
    });

    expect(resolveArtifactPreviewToolbarPublishTarget(artifact, true)).toEqual({
      kind: ArtifactToolbarPublishActionKind.Share,
      artifact,
    });
  });

  test('does not expose sharing without a controller or shareable source', () => {
    const artifact = makeArtifact(ArtifactTypeValue.Image, {
      filePath: '/tmp/image.png',
    });

    expect(resolveArtifactPreviewToolbarPublishTarget(artifact, false)).toBeNull();
    expect(
      resolveArtifactPreviewToolbarPublishTarget(
        makeArtifact(ArtifactTypeValue.Text, { content: 'text' }),
        true,
      ),
    ).toBeNull();
  });

  test('shares a managed HTML preview instead of its loopback preview server', () => {
    const artifact = makeArtifact(ArtifactTypeValue.Html, {
      filePath: '/tmp/index.html',
    });

    expect(resolveBrowserToolbarPublishTarget({
      htmlArtifact: artifact,
      shareAvailable: true,
    })).toEqual({
      kind: ArtifactToolbarPublishActionKind.Share,
      artifact,
    });
  });

  test('does not expose an action for an unshareable managed HTML preview', () => {
    const artifact = makeArtifact(ArtifactTypeValue.Html, {
      content: '<h1>Inline preview</h1>',
    });

    expect(resolveBrowserToolbarPublishTarget({
      htmlArtifact: artifact,
      shareAvailable: true,
    })).toBeNull();
  });

  test('does not expose an action for an ordinary browser page', () => {
    expect(resolveBrowserToolbarPublishTarget({
      shareAvailable: true,
    })).toBeNull();
  });
});

describe('artifactToolbarPublishPolicy (features disabled)', () => {
  test('hides every share entry when the flag is off', async () => {
    vi.resetModules();
    vi.doMock('@shared/featureFlags', () => ({
      ENABLE_HTML_SHARE: false,
    }));
    const policy = await import('./artifactToolbarPublishPolicy');

    expect(policy.resolveArtifactPreviewToolbarPublishTarget(
      makeArtifact(ArtifactTypeValue.Image, { filePath: '/tmp/image.png' }),
      true,
    )).toBeNull();
    expect(policy.resolveBrowserToolbarPublishTarget({
      htmlArtifact: makeArtifact(ArtifactTypeValue.Html, { filePath: '/tmp/index.html' }),
      shareAvailable: true,
    })).toBeNull();
    vi.doUnmock('@shared/featureFlags');
  });
});
