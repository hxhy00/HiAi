import { ArtifactBrowserPartition } from '@shared/artifactPreview/constants';
import { isWorkspaceDiffArtifact } from '@shared/artifactPreview/workspaceChanges';
import {
  BrowserAnnotationGuestChannel,
  BrowserAnnotationGuestCommandType,
  type BrowserAnnotationGuestEnvelope,
  BrowserAnnotationGuestEventType,
  BrowserAnnotationLimit,
  BrowserAnnotationPageScreenshotAnnotationId,
  BrowserAnnotationProtocolVersion,
  type BrowserAnnotationScreenshotRef,
  BrowserAnnotationScreenshotStatus,
  type CoworkBrowserAnnotation,
  type CoworkBrowserAnnotationBatch,
  hasBrowserAnnotationContent,
} from '@shared/cowork/browserAnnotations';
import type { CoworkSelectedTextSnippet } from '@shared/cowork/selectedText';
import {
  HtmlShareAccessMode,
  type HtmlShareAccessMode as HtmlShareAccessModeValue,
  type HtmlShareConfigurableStatus,
  HtmlShareDisabledSource,
  type HtmlShareDisabledSource as HtmlShareDisabledSourceValue,
  HtmlShareErrorCode,
  HtmlShareStatus,
  type HtmlShareStatus as HtmlShareStatusValue,
} from '@shared/htmlShare/constants';
import { LibraryNavigationEvent } from '@shared/library/constants';
import type { LocalWebService } from '@shared/localWebServices/constants';
import {
  type PublishingQuotaErrorData,
  PublishingSubscriptionRecoveryMode,
} from '@shared/publishing/constants';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDispatch, useSelector } from 'react-redux';

import { copyTextToClipboard } from '@/services/clipboard';
import { getPortalPricingUrl, PortalPricingKeyfrom } from '@/services/endpoints';
import { i18nService } from '@/services/i18n';
import { getMarkdownDocumentContent } from '@/services/markdownDocument';
import { refreshOpenOfficeEditor } from '@/services/office/officeFormats';
import { normalizeShellFilePath } from '@/services/shellAppsCache';
import type { RootState } from '@/store';
import {
  addArtifact,
  ArtifactContentView,
  ArtifactSpecialTab,
  closePanel,
  MAX_PANEL_WIDTH,
  MIN_PANEL_WIDTH,
  openArtifactPreviewTab,
  selectActivePreviewTab,
  selectPanelWidth,
  setPanelWidth,
  setPreviewTabContentView,
} from '@/store/slices/artifactSlice';
import {
  removeDraftBrowserAnnotationBatch,
  upsertDraftBrowserAnnotationBatch,
} from '@/store/slices/coworkSlice';
import {
  type Artifact,
  type ArtifactType,
  ArtifactTypeValue,
  PREVIEWABLE_ARTIFACT_TYPES,
} from '@/types/artifact';
import { openLocalPathWithToast, revealLocalPathWithToast } from '@/utils/localFileActions';

import CopyIcon from '../icons/CopyIcon';
import { useOptionalArtifactFileShare } from './ArtifactFileShareController';
import {
  type ArtifactFileShareRequest as HtmlSharePendingRequest,
  ArtifactFileShareRequestSource as HtmlSharePendingSource,
} from './artifactFileSharePolicy';
import ArtifactRenderer from './ArtifactRenderer';
import {
  ArtifactToolbarPublishActionKind,
  type ArtifactToolbarPublishActionKind as ArtifactToolbarPublishActionKindValue,
  resolveArtifactPreviewToolbarPublishTarget,
  resolveBrowserToolbarPublishTarget,
} from './artifactToolbarPublishPolicy';
import { resolveRemovedActiveBrowserAnnotationBatch } from './browserAnnotationSession';
import FileDirectoryView from './FileDirectoryView';
import { formatHtmlShareFailure } from './htmlShareErrorPresentation';
import PublishingQuotaLimitDialog from './PublishingQuotaLimitDialog';
import {
  PublishingTrialStatus,
  usePublishingTrialStatus,
} from './PublishingTrialStatus';
import {
  OfficePreviewActionsContext,
  type OfficePreviewZoomControlsConfig,
} from './renderers/office/common/OfficePreviewActionsContext';
import { OfficeZoomControls } from './renderers/office/common/OfficeZoomControls';

const t = (key: string) => i18nService.t(key);

const logArtifactFileActionFailure = (operation: string, detail?: unknown): void => {
  const message = `${operation} failed${detail ? `: ${String(detail)}` : ''}`;
  console.warn(`[ArtifactPanel] ${message}`);
  try {
    window.electron?.log?.fromRenderer?.('warn', 'ArtifactPanel', message);
  } catch {
    // File action diagnostics must never affect the panel interaction.
  }
};

const BROWSER_OPENABLE_TYPES = new Set<ArtifactType>(['html', 'svg', 'mermaid']);

const SYSTEM_OPENABLE_TYPES = new Set<ArtifactType>(['document', 'video']);

const NON_CODE_TYPES = new Set<ArtifactType>([
  'document',
  'image',
  'video',
  'text',
  ArtifactTypeValue.LocalService,
]);

const COPYABLE_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg']);

const PANEL_CLOSE_DRAG_THRESHOLD = 48;
const FILE_LIST_DRAWER_TRANSITION_MS = 180;
const HtmlSharePhase = {
  Idle: 'idle',
  Checking: 'checking',
  Packing: 'packing',
  Uploading: 'uploading',
  Live: 'live',
  Failed: 'failed',
} as const;

type HtmlSharePhase = (typeof HtmlSharePhase)[keyof typeof HtmlSharePhase];

const HtmlShareDialogKind = {
  Create: 'create',
  Existing: 'existing',
  Result: 'result',
} as const;

type HtmlShareDialogKind = (typeof HtmlShareDialogKind)[keyof typeof HtmlShareDialogKind];

const HtmlShareContentUpdateStatus = {
  Updating: 'updating',
  Complete: 'complete',
  Failed: 'failed',
} as const;

type HtmlShareContentUpdateStatus =
  (typeof HtmlShareContentUpdateStatus)[keyof typeof HtmlShareContentUpdateStatus];

const HtmlShareCopyStatus = {
  Idle: 'idle',
  Copied: 'copied',
  Failed: 'failed',
} as const;

type HtmlShareCopyStatus =
  (typeof HtmlShareCopyStatus)[keyof typeof HtmlShareCopyStatus];

interface HtmlShareDialogState {
  kind: HtmlShareDialogKind;
  title: string;
  message: string;
  shareId?: string;
  url?: string;
  shareCode?: string;
  shareCodeUnavailable?: boolean;
  accessMode?: HtmlShareAccessModeValue;
  selectedAccessMode?: HtmlShareAccessModeValue;
  status?: HtmlShareStatusValue;
  targetStatus?: HtmlShareConfigurableStatus;
  disabledSource?: HtmlShareDisabledSourceValue | null;
  accessExpiresAt?: string | null;
  subscriptionRecoveryMode?: PublishingSubscriptionRecoveryMode;
  statusError?: string;
  contentUpdateStatus?: HtmlShareContentUpdateStatus;
}

interface ExistingHtmlShareInfo {
  shareId: string;
  url: string;
  accessMode?: HtmlShareAccessModeValue;
  shareCode?: string;
  shareCodeUnavailable?: boolean;
  status?: HtmlShareStatusValue;
  disabledSource?: HtmlShareDisabledSourceValue | null;
  accessExpiresAt?: string | null;
  subscriptionRecoveryMode?: PublishingSubscriptionRecoveryMode;
}

interface HtmlShareLookupState {
  sourceKey: string;
  isLoading: boolean;
  share?: ExistingHtmlShareInfo;
}

function getExistingHtmlShareInfo(
  share: {
    shareId?: string;
    url?: string;
    accessMode?: HtmlShareAccessModeValue;
    shareCode?: string;
    shareCodeUnavailable?: boolean;
    status?: HtmlShareStatusValue;
    disabledSource?: HtmlShareDisabledSourceValue | null;
    accessExpiresAt?: string | null;
    subscriptionRecoveryMode?: PublishingSubscriptionRecoveryMode;
  } | null | undefined,
): ExistingHtmlShareInfo | null {
  if (!share?.shareId || !share.url) return null;
  return {
    shareId: share.shareId,
    url: share.url,
    accessMode: share.accessMode,
    shareCode: share.shareCode,
    shareCodeUnavailable: share.shareCodeUnavailable,
    status: share.status,
    disabledSource: share.disabledSource,
    ...(Object.prototype.hasOwnProperty.call(share, 'accessExpiresAt')
      ? { accessExpiresAt: share.accessExpiresAt }
      : {}),
    subscriptionRecoveryMode: share.subscriptionRecoveryMode,
  };
}

function getHtmlShareFailureMessage(
  result:
    | {
        code?: number;
        error?: string;
      }
    | null
    | undefined,
): string {
  return formatHtmlShareFailure(result);
}

function resolveAccessExpiresAt(
  value: { accessExpiresAt?: string | null } | null | undefined,
  fallback?: string | null,
): string | null | undefined {
  return value && Object.prototype.hasOwnProperty.call(value, 'accessExpiresAt')
    ? value.accessExpiresAt
    : fallback;
}

function getConfigurableHtmlShareStatus(
  status?: HtmlShareStatusValue,
): HtmlShareConfigurableStatus | undefined {
  if (status === HtmlShareStatus.Failed) return undefined;
  return status === HtmlShareStatus.Disabled ? HtmlShareStatus.Disabled : HtmlShareStatus.Live;
}

function normalizeHtmlShareAccessMode(
  accessMode?: HtmlShareAccessModeValue,
): HtmlShareAccessModeValue {
  return accessMode === HtmlShareAccessMode.Public
    ? HtmlShareAccessMode.Public
    : HtmlShareAccessMode.Code;
}

function shouldUseHtmlShareCode(
  accessMode?: HtmlShareAccessModeValue,
): boolean {
  return normalizeHtmlShareAccessMode(accessMode) === HtmlShareAccessMode.Code;
}

function isCopyableArtifact(artifact: Artifact): boolean {
  if (artifact.type === 'document' || artifact.type === 'video') return false;
  if (artifact.type === ArtifactTypeValue.LocalService) return false;
  if (artifact.type === 'image') {
    const filename = artifact.fileName || artifact.filePath || '';
    const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
    return COPYABLE_IMAGE_EXTENSIONS.has(ext);
  }
  return true;
}

function dataUrlToPngBlob(dataUrl: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Failed to get canvas context'));
        return;
      }
      ctx.drawImage(img, 0, 0);
      canvas.toBlob(blob => {
        if (blob) resolve(blob);
        else reject(new Error('Failed to convert image to blob'));
      }, 'image/png');
    };
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = dataUrl;
  });
}

function buildBrowserHtml(artifact: Artifact): string | null {
  switch (artifact.type) {
    case 'html':
      return artifact.content;
    case 'svg':
      return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${artifact.title}</title><style>body{margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f5f5f5}</style></head><body>${artifact.content}</body></html>`;
    case 'mermaid':
      return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${artifact.title}</title><script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"><\/script><style>body{margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#fff;font-family:system-ui,sans-serif}</style></head><body><pre class="mermaid">${escapeHtml(artifact.content)}</pre><script>mermaid.initialize({startOnLoad:true,theme:'default',securityLevel:'loose'});<\/script></body></html>`;
    default:
      return null;
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

interface ArtifactPanelProps {
  sessionId: string;
  artifacts: Artifact[];
  activeSpecialTab?: ArtifactSpecialTab;
  minPanelWidth?: number;
  maxPanelWidth?: number;
  isPanelExpanded?: boolean;
  browserAddress?: string;
  browserUrl?: string;
  browserHtmlArtifactId?: string | null;
  onBrowserAddressChange?: (value: string) => void;
  onBrowserUrlChange?: (value: string) => void;
  onBrowserTitleChange?: (value: string) => void;
  onOpenFileListTab?: () => void;
  onOpenBrowserTab?: () => void;
  onOpenHtmlFileInBrowser?: (artifact: Artifact) => void;
  onAddSelectedText?: (snippet: CoworkSelectedTextSnippet) => void;
  selectedTextEnabled?: boolean;
  agentBrowserPanel?: React.ReactNode;
  subagentPanel?: React.ReactNode;
  userAttachmentPanel?: React.ReactNode;
  onAnnotationSend?: () => void;
}

interface BrowserPublishAction {
  kind: ArtifactToolbarPublishActionKindValue;
  label: string;
  disabled: boolean;
  busy: boolean;
  onClick: () => void;
}

export const BrowserAnnotationShape = {
  Rectangle: 'rectangle',
} as const;

export type BrowserAnnotationShape =
  (typeof BrowserAnnotationShape)[keyof typeof BrowserAnnotationShape];

export const BrowserAnnotationColor = {
  Blue: 'blue',
} as const;

export type BrowserAnnotationColor =
  (typeof BrowserAnnotationColor)[keyof typeof BrowserAnnotationColor];

export interface BrowserAnnotationElementInfo {
  tagName: string;
  text: string;
  color: string;
  fontFamily: string;
  width: number;
  height: number;
}

export interface BrowserAnnotationRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserAnnotationScreenshotInfo {
  width: number;
  height: number;
  devicePixelRatio: number;
}

export interface BrowserAnnotationMarkInfo extends BrowserAnnotationRect {
  shape: BrowserAnnotationShape;
  color: BrowserAnnotationColor;
}

export interface BrowserAnnotationPayload {
  comment: string;
  imageDataUrl: string;
  pageUrl: string;
  pageTitle: string;
  screenshot: BrowserAnnotationScreenshotInfo;
  annotation: BrowserAnnotationMarkInfo;
  element: BrowserAnnotationElementInfo;
}

const EMPTY_BROWSER_ANNOTATION_BATCHES: CoworkBrowserAnnotationBatch[] = [];

const ArtifactPanel: React.FC<ArtifactPanelProps> = ({
  sessionId,
  artifacts,
  activeSpecialTab = ArtifactSpecialTab.FileList,
  minPanelWidth = MIN_PANEL_WIDTH,
  maxPanelWidth = MAX_PANEL_WIDTH,
  isPanelExpanded = false,
  browserAddress: controlledBrowserAddress,
  browserUrl: controlledBrowserUrl,
  browserHtmlArtifactId,
  onBrowserAddressChange,
  onBrowserUrlChange,
  onBrowserTitleChange,
  onOpenFileListTab,
  onOpenBrowserTab,
  onOpenHtmlFileInBrowser,
  onAddSelectedText,
  selectedTextEnabled = false,
  agentBrowserPanel,
  subagentPanel,
  userAttachmentPanel,
  onAnnotationSend,
}) => {
  const dispatch = useDispatch();
  const artifactFileShare = useOptionalArtifactFileShare();
  const panelWidth = useSelector(selectPanelWidth);
  const activePreviewTab = useSelector((state: RootState) =>
    selectActivePreviewTab(state, sessionId),
  );
  const browserAnnotationBatches = useSelector(
    (state: RootState) => (
      state.cowork.draftBrowserAnnotationBatches[sessionId]
      || EMPTY_BROWSER_ANNOTATION_BATCHES
    ),
  );
  // Annotations that survive send-time normalization (comment or element edit).
  const annotationSendCount = useMemo(() => browserAnnotationBatches.reduce(
    (total, batch) => total + batch.annotations.filter(
      annotation => hasBrowserAnnotationContent(annotation.comment, annotation.elementEdit),
    ).length,
    0,
  ), [browserAnnotationBatches]);
  const [showFileListDrawer, setShowFileListDrawer] = useState(false);
  const [isFileListDrawerVisible, setIsFileListDrawerVisible] = useState(false);
  const [localBrowserAddress, setLocalBrowserAddress] = useState('');
  const [localBrowserUrl, setLocalBrowserUrl] = useState('');
  const [htmlSharePhase, setHtmlSharePhase] = useState<HtmlSharePhase>(HtmlSharePhase.Idle);
  const [htmlShareDialog, setHtmlShareDialog] = useState<HtmlShareDialogState | null>(null);
  const [htmlSharePendingRequest, setHtmlSharePendingRequest] =
    useState<HtmlSharePendingRequest | null>(null);
  const [, setHtmlShareLookup] = useState<HtmlShareLookupState | null>(null);
  const [publishingQuotaDialog, setPublishingQuotaDialog] =
    useState<PublishingQuotaErrorData | null>(null);
  const [isHtmlShareStatusUpdating, setIsHtmlShareStatusUpdating] = useState(false);
  const [htmlShareCopyStatus, setHtmlShareCopyStatus] =
    useState<HtmlShareCopyStatus>(HtmlShareCopyStatus.Idle);
  const [isArtifactActionsMenuOpen, setIsArtifactActionsMenuOpen] = useState(false);
  const [officePreviewZoomControls, setOfficePreviewZoomControls] =
    useState<OfficePreviewZoomControlsConfig | null>(null);
  const fileListDrawerRef = useRef<HTMLDivElement>(null);
  const fileListButtonRef = useRef<HTMLButtonElement>(null);
  const artifactActionsMenuRef = useRef<HTMLDivElement>(null);
  const artifactActionsMenuButtonRef = useRef<HTMLButtonElement>(null);
  const fileListDrawerAnimationFrameRef = useRef<number | undefined>(undefined);
  const fileListDrawerCloseTimeoutRef = useRef<number | undefined>(undefined);
  const htmlShareCopyStatusTimerRef = useRef<number | undefined>(undefined);
  const publishingAccountContextRef = useRef({
    accountGeneration: 0,
    ownerAccountKey: 'local',
  });
  const publishingAccountGenerationRef = useRef(0);
  publishingAccountGenerationRef.current = 0;

  const previewableArtifacts = artifacts.filter(a => PREVIEWABLE_ARTIFACT_TYPES.has(a.type));
  const artifactsById = useMemo(
    () => new Map(artifacts.map(artifact => [artifact.id, artifact])),
    [artifacts],
  );
  const selectedArtifact = activePreviewTab
    ? (artifactsById.get(activePreviewTab.artifactId) ?? null)
    : null;
  const browserHtmlArtifact = browserHtmlArtifactId
    ? (artifactsById.get(browserHtmlArtifactId) ?? null)
    : null;
  const isBrowserTabActive = !selectedArtifact && activeSpecialTab === ArtifactSpecialTab.Browser;
  const artifactToolbarPublishTarget = resolveArtifactPreviewToolbarPublishTarget(
    selectedArtifact,
    Boolean(artifactFileShare),
  );
  const selectedArtifactId = selectedArtifact?.id ?? null;
  const activeTab = activePreviewTab?.contentView ?? ArtifactContentView.Preview;
  const canShowCodeView = Boolean(selectedArtifact && !NON_CODE_TYPES.has(selectedArtifact.type));
  const isCodeViewActive = canShowCodeView && activeTab === ArtifactContentView.Code;
  const contentViewActionTarget = isCodeViewActive
    ? ArtifactContentView.Preview
    : ArtifactContentView.Code;
  const contentViewActionLabel = isCodeViewActive
    ? t('artifactPreview')
    : t('artifactCode');
  const selectedTextContext = useMemo(
    () => (
      selectedTextEnabled && onAddSelectedText
        ? { enabled: true, onAddSelectedText }
        : undefined
    ),
    [onAddSelectedText, selectedTextEnabled],
  );
  const isResizing = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);
  const previousBodyCursor = useRef('');
  const [panelIsResizing, setPanelIsResizing] = useState(false);
  const constrainedMaxPanelWidth = isPanelExpanded
    ? Math.max(MIN_PANEL_WIDTH, maxPanelWidth)
    : Math.max(
        MIN_PANEL_WIDTH,
        Math.min(MAX_PANEL_WIDTH, maxPanelWidth),
      );
  const constrainedMinPanelWidth = Math.min(
    constrainedMaxPanelWidth,
    Math.max(MIN_PANEL_WIDTH, minPanelWidth),
  );
  const constrainedPanelWidth = Math.max(
    constrainedMinPanelWidth,
    Math.min(constrainedMaxPanelWidth, panelWidth),
  );
  const browserAddress = controlledBrowserAddress ?? localBrowserAddress;
  const browserUrl = controlledBrowserUrl ?? localBrowserUrl;
  const browserAnnotationBatch = useMemo(
    () => browserAnnotationBatches.find(batch => (
      normalizeBrowserPreviewUrlForMatch(batch.pageUrl)
      === normalizeBrowserPreviewUrlForMatch(browserUrl)
    )),
    [browserAnnotationBatches, browserUrl],
  );
  const browserToolbarPublishTarget = resolveBrowserToolbarPublishTarget({
    htmlArtifact: isBrowserTabActive ? browserHtmlArtifact : null,
    shareAvailable: Boolean(artifactFileShare),
  });
  const isHtmlSharing =
    htmlSharePhase === HtmlSharePhase.Checking ||
    htmlSharePhase === HtmlSharePhase.Packing ||
    htmlSharePhase === HtmlSharePhase.Uploading;
  const browserHtmlAutoRefreshFilePath =
    isBrowserTabActive && browserHtmlArtifact?.type === ArtifactTypeValue.Html
      ? browserHtmlArtifact.filePath
      : undefined;
  const browserHtmlPreviewUrl = browserHtmlAutoRefreshFilePath ? browserUrl : undefined;
  const canUseHtmlShareDialogLink = Boolean(
    htmlShareDialog?.url &&
      !isHtmlShareStatusUpdating &&
      htmlShareDialog.status !== HtmlShareStatus.Disabled &&
      htmlShareDialog.status !== HtmlShareStatus.Failed,
  );
  const canRestoreActiveLimitDisabledHtmlShare = Boolean(
    htmlShareDialog?.kind === HtmlShareDialogKind.Existing &&
      htmlShareDialog.status === HtmlShareStatus.Disabled &&
      htmlShareDialog.disabledSource === HtmlShareDisabledSource.ActiveLimit,
  );
  const isHtmlShareContentUpdateDisabled = Boolean(
    isHtmlShareStatusUpdating ||
      htmlShareDialog?.status === HtmlShareStatus.Disabled ||
      htmlShareDialog?.targetStatus === HtmlShareStatus.Disabled,
  );
  const isCompactHtmlToolbar = selectedArtifact?.type === ArtifactTypeValue.Html;
  const isCompactArtifactToolbar = Boolean(selectedArtifact);
  const showRefreshAction = Boolean(selectedArtifact?.filePath);
  const showCopyAction = Boolean(selectedArtifact && isCopyableArtifact(selectedArtifact));
  const showOpenBrowserAction = Boolean(
    selectedArtifact && BROWSER_OPENABLE_TYPES.has(selectedArtifact.type),
  );
  const showOpenWithAppAction = Boolean(
    selectedArtifact &&
      SYSTEM_OPENABLE_TYPES.has(selectedArtifact.type) &&
      selectedArtifact.filePath,
  );
  const showRevealInFolderAction = Boolean(selectedArtifact?.filePath);
  const showPrimaryOpenWithAppAction = Boolean(!isCompactHtmlToolbar && showOpenWithAppAction);
  const showPrimaryRevealInFolderAction = Boolean(
    !isCompactHtmlToolbar &&
      !showPrimaryOpenWithAppAction &&
      showRevealInFolderAction,
  );
  const showOpenBrowserActionInMenu = Boolean(!isCompactHtmlToolbar && showOpenBrowserAction);
  const showOpenWithAppActionInMenu = Boolean(isCompactHtmlToolbar && showOpenWithAppAction);
  const showRevealInFolderActionInMenu = Boolean(
    showRevealInFolderAction && !showPrimaryRevealInFolderAction,
  );
  const showContentViewActionInMenu = canShowCodeView;
  const showOfficeZoomControlsInMenu = Boolean(officePreviewZoomControls);
  const hasArtifactActionMenuItems = Boolean(
    showContentViewActionInMenu ||
      showRefreshAction ||
      showCopyAction ||
      showOpenBrowserActionInMenu ||
      showOpenWithAppActionInMenu ||
      showRevealInFolderActionInMenu,
  );
  const showArtifactActionsMenu = Boolean(
    isCompactArtifactToolbar &&
      (hasArtifactActionMenuItems || showOfficeZoomControlsInMenu),
  );
  const officePreviewActionsContextValue = useMemo(
    () => ({
      setZoomControls: setOfficePreviewZoomControls,
    }),
    [],
  );

  const handleBrowserAddressChange = useCallback(
    (value: string) => {
      setLocalBrowserAddress(value);
      onBrowserAddressChange?.(value);
    },
    [onBrowserAddressChange],
  );

  const handleBrowserUrlChange = useCallback(
    (value: string) => {
      setLocalBrowserUrl(value);
      onBrowserUrlChange?.(value);
    },
    [onBrowserUrlChange],
  );

  const openFileListDrawer = useCallback(() => {
    if (fileListDrawerCloseTimeoutRef.current !== undefined) {
      window.clearTimeout(fileListDrawerCloseTimeoutRef.current);
      fileListDrawerCloseTimeoutRef.current = undefined;
    }
    if (fileListDrawerAnimationFrameRef.current !== undefined) {
      window.cancelAnimationFrame(fileListDrawerAnimationFrameRef.current);
    }

    setShowFileListDrawer(true);
    fileListDrawerAnimationFrameRef.current = window.requestAnimationFrame(() => {
      fileListDrawerAnimationFrameRef.current = undefined;
      setIsFileListDrawerVisible(true);
    });
  }, []);

  const closeFileListDrawer = useCallback(() => {
    if (fileListDrawerAnimationFrameRef.current !== undefined) {
      window.cancelAnimationFrame(fileListDrawerAnimationFrameRef.current);
      fileListDrawerAnimationFrameRef.current = undefined;
    }
    if (fileListDrawerCloseTimeoutRef.current !== undefined) {
      window.clearTimeout(fileListDrawerCloseTimeoutRef.current);
    }

    setIsFileListDrawerVisible(false);
    fileListDrawerCloseTimeoutRef.current = window.setTimeout(() => {
      setShowFileListDrawer(false);
      fileListDrawerCloseTimeoutRef.current = undefined;
    }, FILE_LIST_DRAWER_TRANSITION_MS);
  }, []);

  const toggleFileListDrawer = useCallback(() => {
    if (showFileListDrawer && isFileListDrawerVisible) {
      closeFileListDrawer();
      return;
    }

    openFileListDrawer();
  }, [
    closeFileListDrawer,
    isFileListDrawerVisible,
    openFileListDrawer,
    showFileListDrawer,
  ]);

  const handleResizeStart = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (isPanelExpanded) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      isResizing.current = true;
      startX.current = e.clientX;
      startWidth.current = constrainedPanelWidth;
      previousBodyCursor.current = document.body.style.cursor;
      document.body.style.cursor = 'col-resize';
      document.body.classList.add('select-none');
      setPanelIsResizing(true);

      const stopResizing = () => {
        isResizing.current = false;
        document.body.style.cursor = previousBodyCursor.current;
        document.body.classList.remove('select-none');
        setPanelIsResizing(false);
        document.removeEventListener('pointermove', handlePointerMove);
        document.removeEventListener('pointerup', handlePointerUp);
        document.removeEventListener('pointercancel', handlePointerUp);
      };

      const handlePointerMove = (moveEvent: PointerEvent) => {
        if (!isResizing.current) return;
        moveEvent.preventDefault();
        const nextWidth = startWidth.current + startX.current - moveEvent.clientX;
        if (nextWidth < constrainedMinPanelWidth - PANEL_CLOSE_DRAG_THRESHOLD) {
          stopResizing();
          dispatch(closePanel({ sessionId }));
          return;
        }
        const clampedWidth = Math.max(
          constrainedMinPanelWidth,
          Math.min(constrainedMaxPanelWidth, nextWidth),
        );
        dispatch(setPanelWidth(clampedWidth));
      };

      const handlePointerUp = () => {
        stopResizing();
      };

      document.addEventListener('pointermove', handlePointerMove);
      document.addEventListener('pointerup', handlePointerUp);
      document.addEventListener('pointercancel', handlePointerUp);
    },
    [
      constrainedMaxPanelWidth,
      constrainedMinPanelWidth,
      constrainedPanelWidth,
      dispatch,
      isPanelExpanded,
      sessionId,
    ],
  );

  useEffect(() => {
    return () => {
      if (fileListDrawerAnimationFrameRef.current !== undefined) {
        window.cancelAnimationFrame(fileListDrawerAnimationFrameRef.current);
      }
      if (fileListDrawerCloseTimeoutRef.current !== undefined) {
        window.clearTimeout(fileListDrawerCloseTimeoutRef.current);
      }
      if (htmlShareCopyStatusTimerRef.current !== undefined) {
        window.clearTimeout(htmlShareCopyStatusTimerRef.current);
      }
      document.body.style.cursor = previousBodyCursor.current;
      document.body.classList.remove('select-none');
    };
  }, []);

  useEffect(() => {
    publishingAccountContextRef.current = {
      accountGeneration: 0,
      ownerAccountKey: 'local',
    };
    publishingAccountGenerationRef.current = 0;
    setHtmlShareDialog(null);
    setHtmlSharePendingRequest(null);
    setHtmlShareLookup(null);
    setHtmlSharePhase(HtmlSharePhase.Idle);
    setPublishingQuotaDialog(null);
    setIsHtmlShareStatusUpdating(false);
  }, []);

  useEffect(() => {
    if (htmlShareCopyStatusTimerRef.current !== undefined) {
      window.clearTimeout(htmlShareCopyStatusTimerRef.current);
      htmlShareCopyStatusTimerRef.current = undefined;
    }
    setHtmlShareCopyStatus(HtmlShareCopyStatus.Idle);
  }, [
    htmlShareDialog?.shareId,
    htmlShareDialog?.url,
  ]);

  useEffect(() => {
    if (selectedArtifact) return;
    closeFileListDrawer();
    setIsArtifactActionsMenuOpen(false);
  }, [closeFileListDrawer, selectedArtifact]);

  useEffect(() => {
    closeFileListDrawer();
    setIsArtifactActionsMenuOpen(false);
  }, [activePreviewTab?.id, closeFileListDrawer]);

  useEffect(() => {
    if (!isArtifactActionsMenuOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        artifactActionsMenuRef.current?.contains(target) ||
        artifactActionsMenuButtonRef.current?.contains(target)
      ) {
        return;
      }
      setIsArtifactActionsMenuOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsArtifactActionsMenuOpen(false);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isArtifactActionsMenuOpen]);

  useEffect(() => {
    if (!showFileListDrawer) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        fileListDrawerRef.current?.contains(target) ||
        fileListButtonRef.current?.contains(target)
      ) {
        return;
      }
      closeFileListDrawer();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeFileListDrawer();
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [closeFileListDrawer, showFileListDrawer]);

  // Auto-refresh when the previewed file changes on disk. Markdown is left out: EditableMarkdownFile
  // polls and version-checks its file itself, and a watch would re-read it after each autosave.
  useEffect(() => {
    const filePath = selectedArtifact?.filePath;
    if (!filePath || selectedArtifact?.type === ArtifactTypeValue.Markdown) return;

    let cleanup: (() => void) | undefined;
    let watchedPath: string | null = null;

    window.electron?.artifact?.watchFile(filePath);
    watchedPath = filePath;

    cleanup = window.electron?.artifact?.onFileChanged(({ filePath: changedPath }) => {
      if (changedPath === watchedPath) {
        handleRefreshRef.current();
      }
    });

    return () => {
      if (cleanup) cleanup();
      if (watchedPath) window.electron?.artifact?.unwatchFile(watchedPath);
    };
  }, [selectedArtifact?.filePath, selectedArtifact?.type]);

  const openLocalServiceArtifact = useCallback(
    (artifact: Artifact): boolean => {
      if (artifact.type !== ArtifactTypeValue.LocalService) return false;
      const url = artifact.url || artifact.content;
      if (!url) return true;
      onOpenBrowserTab?.();
      handleBrowserAddressChange(url);
      handleBrowserUrlChange(url);
      return true;
    },
    [handleBrowserAddressChange, handleBrowserUrlChange, onOpenBrowserTab],
  );

  const handleSelectArtifact = useCallback(
    (id: string) => {
      const artifact = artifacts.find(item => item.id === id);
      if (artifact && openLocalServiceArtifact(artifact)) return;
      if (artifact?.type === ArtifactTypeValue.Html && artifact.filePath && onOpenHtmlFileInBrowser) {
        onOpenHtmlFileInBrowser(artifact);
        return;
      }
      onOpenFileListTab?.();
      dispatch(openArtifactPreviewTab({ sessionId, artifactId: id }));
    },
    [
      artifacts,
      dispatch,
      onOpenFileListTab,
      onOpenHtmlFileInBrowser,
      openLocalServiceArtifact,
      sessionId,
    ],
  );

  const handleSelectArtifactFromDrawer = useCallback(
    (id: string) => {
      const artifact = artifacts.find(item => item.id === id);
      if (artifact && openLocalServiceArtifact(artifact)) {
        closeFileListDrawer();
        return;
      }
      if (artifact?.type === ArtifactTypeValue.Html && artifact.filePath && onOpenHtmlFileInBrowser) {
        onOpenHtmlFileInBrowser(artifact);
        closeFileListDrawer();
        return;
      }
      dispatch(openArtifactPreviewTab({ sessionId, artifactId: id }));
      closeFileListDrawer();
    },
    [
      artifacts,
      closeFileListDrawer,
      dispatch,
      onOpenHtmlFileInBrowser,
      openLocalServiceArtifact,
      sessionId,
    ],
  );

  const handleSetContentView = useCallback(
    (contentView: ArtifactContentView) => {
      if (!activePreviewTab) return;
      dispatch(
        setPreviewTabContentView({
          sessionId,
          tabId: activePreviewTab.id,
          contentView,
        }),
      );
    },
    [activePreviewTab, dispatch, sessionId],
  );

  const handleShareSelectedArtifact = useCallback(() => {
    if (!artifactFileShare || !artifactToolbarPublishTarget) return;
    void artifactFileShare.openShare(artifactToolbarPublishTarget.artifact, {});
  }, [artifactFileShare, artifactToolbarPublishTarget]);

  const handleShareBrowserHtmlArtifact = useCallback(() => {
    if (
      !artifactFileShare ||
      browserToolbarPublishTarget?.kind !== ArtifactToolbarPublishActionKind.Share
    ) {
      return;
    }
    void artifactFileShare.openShare(browserToolbarPublishTarget.artifact, {});
  }, [artifactFileShare, browserToolbarPublishTarget]);

  const handleCopy = useCallback(async () => {
    if (!selectedArtifact) return;
    try {
      if (selectedArtifact.type === 'image') {
        if (selectedArtifact.filePath) {
          const result = await window.electron?.clipboard?.writeImageFromFile(
            selectedArtifact.filePath,
          );
          if (!result?.success) {
            logArtifactFileActionFailure('copy artifact image', result?.error);
            window.dispatchEvent(
              new CustomEvent('app:showToast', { detail: result?.error || t('copyFailed') }),
            );
            return;
          }
        } else if (selectedArtifact.content) {
          const blob = await dataUrlToPngBlob(selectedArtifact.content);
          await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
        }
      } else {
        const editingContent = selectedArtifact.type === ArtifactTypeValue.Markdown && selectedArtifact.filePath
          ? getMarkdownDocumentContent(selectedArtifact.filePath) : undefined;
        if (editingContent !== undefined) {
          if (!await copyTextToClipboard(editingContent)) {
            throw new Error('Failed to copy Markdown editor content');
          }
        } else if (selectedArtifact.filePath && !selectedArtifact.content && selectedArtifact.type !== 'document') {
          const result = await window.electron?.dialog?.readTextFile?.(selectedArtifact.filePath);
          if (result?.truncated) {
            logArtifactFileActionFailure(
              'copy artifact content',
              `file exceeds read limit; size=${result.size ?? 'unknown'}, readBytes=${result.readBytes ?? 'unknown'}`,
            );
            window.dispatchEvent(new CustomEvent('app:showToast', {
              detail: t('fileMenuCopyContentsTooLarge'),
            }));
            return;
          }
          if (!result?.success || typeof result.content !== 'string') {
            logArtifactFileActionFailure('copy artifact content', result?.error);
            window.dispatchEvent(new CustomEvent('app:showToast', { detail: result?.error || t('copyFailed') }));
            return;
          }
          if (!await copyTextToClipboard(result.content)) {
            throw new Error('Failed to copy artifact file content');
          }
        } else {
          if (!await copyTextToClipboard(selectedArtifact.content)) {
            throw new Error('Failed to copy artifact content');
          }
        }
      }
      window.dispatchEvent(new CustomEvent('app:showToast', { detail: t('messageCopied') }));
    } catch (error) {
      logArtifactFileActionFailure('copy artifact content', error);
      window.dispatchEvent(new CustomEvent('app:showToast', { detail: t('copyFailed') }));
    }
  }, [selectedArtifact]);

  const handleRevealInFolder = useCallback(() => {
    if (!selectedArtifact?.filePath) return;
    void revealLocalPathWithToast(selectedArtifact.filePath);
  }, [selectedArtifact]);

  const handleOpenInBrowser = useCallback(() => {
    if (!selectedArtifact) return;

    if (
      selectedArtifact.type === ArtifactTypeValue.Html &&
      selectedArtifact.filePath &&
      onOpenHtmlFileInBrowser
    ) {
      onOpenHtmlFileInBrowser(selectedArtifact);
      return;
    }

    // Mermaid needs HTML wrapper with mermaid.js to render in browser
    if (selectedArtifact.type === 'mermaid') {
      if (!selectedArtifact.content) return;
      const html = buildBrowserHtml(selectedArtifact);
      if (html) {
        window.electron?.shell?.openHtmlInBrowser(html);
      }
      return;
    }

    // Has file on disk: open directly via native path
    // NOTE: shell.openExternal with file:// URLs fails on Windows when path contains
    // non-ASCII characters (e.g. Chinese) — ERROR_FILE_NOT_FOUND (0x2).
    // Use shell.openPath which handles native Unicode paths correctly.
    if (selectedArtifact.filePath) {
      void openLocalPathWithToast(selectedArtifact.filePath);
      return;
    }

    // No file path: generate HTML and open via temp file
    if (!selectedArtifact.content) return;
    const html = buildBrowserHtml(selectedArtifact);
    if (html) {
      window.electron?.shell?.openHtmlInBrowser(html);
    }
  }, [onOpenHtmlFileInBrowser, selectedArtifact]);

  const closePublishingQuotaDialog = useCallback(() => {
    setPublishingQuotaDialog(null);
  }, []);

  const openSubscriptionPage = useCallback(() => {
    void window.electron?.shell?.openExternal(
      getPortalPricingUrl(PortalPricingKeyfrom.HtmlShare),
    );
    if (publishingQuotaDialog) {
      closePublishingQuotaDialog();
    }
  }, [closePublishingQuotaDialog, publishingQuotaDialog]);

  const formatShareClipboardText = useCallback((url: string, shareCode?: string): string => {
    if (!shareCode) return url;
    const linkLine = `${t('htmlShareClipboardLinkLabel')}: ${url}`;
    return `${linkLine}\n${t('htmlShareCode')}: ${shareCode}`;
  }, []);

  const showHtmlShareCopyStatus = useCallback((status: HtmlShareCopyStatus) => {
    if (htmlShareCopyStatusTimerRef.current !== undefined) {
      window.clearTimeout(htmlShareCopyStatusTimerRef.current);
    }
    setHtmlShareCopyStatus(status);
    htmlShareCopyStatusTimerRef.current = window.setTimeout(() => {
      setHtmlShareCopyStatus(HtmlShareCopyStatus.Idle);
      htmlShareCopyStatusTimerRef.current = undefined;
    }, 2200);
  }, []);

  // Client-side entitlement gating was removed with subscriptions (remove-membership
  // §11 D2/D3): the server enforces any remaining publishing quotas and the quota
  // dialogs still handle those rejections.

  const handleCopyShareLink = useCallback(
    async (
      url?: string,
      shareCode?: string,
    ) => {
      if (!url) return;
      const copied = await copyTextToClipboard(formatShareClipboardText(url, shareCode));
      if (copied) {
        showHtmlShareCopyStatus(HtmlShareCopyStatus.Copied);
      } else {
        showHtmlShareCopyStatus(HtmlShareCopyStatus.Failed);
      }
    },
    [formatShareClipboardText, showHtmlShareCopyStatus],
  );

  const rememberHtmlShare = useCallback((sourceKey: string, share: unknown) => {
    const existingShare = getExistingHtmlShareInfo(
      share as {
        shareId?: string;
        url?: string;
        accessMode?: HtmlShareAccessModeValue;
        shareCode?: string;
        shareCodeUnavailable?: boolean;
        status?: HtmlShareStatusValue;
        disabledSource?: HtmlShareDisabledSourceValue | null;
        accessExpiresAt?: string | null;
      } | null | undefined,
    );
    if (!existingShare) return;
    setHtmlShareLookup({
      sourceKey,
      isLoading: false,
      share: existingShare,
    });
  }, []);

  const showPublishingQuotaDialog = useCallback((
    quota: PublishingQuotaErrorData | null | undefined,
  ): boolean => {
    if (!quota) return false;
    setHtmlShareDialog(null);
    setHtmlSharePendingRequest(null);
    setPublishingQuotaDialog(quota);
    return true;
  }, []);

  const handleHtmlShareResult = useCallback(
    (
      result: Awaited<
        ReturnType<NonNullable<typeof window.electron>['htmlShare']['createFromHtmlFile']>
      >,
      action: 'create' | 'update' = 'create',
    ): boolean => {
      if (!result?.success || !result.url) {
        if (showPublishingQuotaDialog(result?.quota)) {
          setHtmlSharePhase(HtmlSharePhase.Failed);
          return false;
        }
        if (result?.code === HtmlShareErrorCode.SubscriptionRequired) {
          setHtmlShareDialog(null);
          setHtmlSharePendingRequest(null);
          setHtmlSharePhase(HtmlSharePhase.Failed);
          return false;
        }
        throw new Error(getHtmlShareFailureMessage(result));
      }
      const accessMode = normalizeHtmlShareAccessMode(result.accessMode);
      setHtmlSharePhase(HtmlSharePhase.Live);
      setHtmlShareDialog({
        kind: HtmlShareDialogKind.Result,
        title:
          action === 'update'
            ? t('htmlShareUpdated')
            : t('htmlShareSuccess'),
        message: result.shareCodeUnavailable
          ? t('htmlShareCodeUnavailable')
          : result.warnings?.length
          ? result.warnings.slice(0, 3).join('\n')
          : action === 'update'
            ? result.status === HtmlShareStatus.Disabled
              ? t('htmlShareUpdatedClosedMessage')
              : t('htmlShareUpdateComplete')
            : shouldUseHtmlShareCode(accessMode)
              ? t('htmlShareCodeViewHint')
              : t('htmlSharePublicViewHint'),
        url: result.url,
        accessMode,
        selectedAccessMode: accessMode,
        shareCode: shouldUseHtmlShareCode(accessMode) ? result.shareCode : undefined,
        shareCodeUnavailable: result.shareCodeUnavailable,
        status: result.status,
        disabledSource: result.disabledSource,
        accessExpiresAt: result.accessExpiresAt,
      });
      return true;
    },
    [showPublishingQuotaDialog],
  );

  const createHtmlShare = useCallback(async (request: HtmlSharePendingRequest) => {
    if (isHtmlSharing) return;
    const requestAccountGeneration = publishingAccountGenerationRef.current;
    setHtmlShareDialog(null);
    setHtmlSharePendingRequest(null);
    try {
      setHtmlSharePhase(HtmlSharePhase.Packing);
      setHtmlSharePhase(HtmlSharePhase.Uploading);
      window.electron?.log?.fromRenderer?.(
        'debug',
        'ArtifactPanel',
        `Creating ${request.sourceType} share for artifact ${request.artifactId}.`,
      );
      const result =
        request.source === HtmlSharePendingSource.HtmlFile
          ? await window.electron?.htmlShare?.createFromHtmlFile({
              sessionId: request.sessionId,
              artifactId: request.artifactId,
              filePath: request.filePath || '',
              title: request.title,
              accessMode: request.accessMode,
            })
          : await window.electron?.htmlShare?.createFromArtifactFile({
              sourceType: request.sourceType,
              sessionId: request.sessionId,
              artifactId: request.artifactId,
              title: request.title,
              accessMode: request.accessMode,
              fileName: request.fileName,
              filePath: request.filePath,
              content: request.content,
              remoteUrl: request.remoteUrl,
            });
      if (publishingAccountGenerationRef.current !== requestAccountGeneration) return;
      if (!handleHtmlShareResult(result)) return;
      rememberHtmlShare(request.lookupKey, result);
      window.electron?.log?.fromRenderer?.(
        'debug',
        'ArtifactPanel',
        `Created ${request.sourceType} share for artifact ${request.artifactId}.`,
      );
    } catch (error) {
      if (publishingAccountGenerationRef.current !== requestAccountGeneration) return;
      window.electron?.log?.fromRenderer?.(
        'warn',
        'ArtifactPanel',
        `Failed to create ${request.sourceType} share for artifact ${request.artifactId}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      setHtmlSharePhase(HtmlSharePhase.Failed);
      setHtmlShareDialog({
        kind: HtmlShareDialogKind.Result,
        title: t('htmlShareFailed'),
        message: error instanceof Error ? error.message : t('htmlShareFailed'),
      });
    }
  }, [handleHtmlShareResult, isHtmlSharing, rememberHtmlShare]);

  const selectHtmlShareAccessMode = useCallback((accessMode: HtmlShareAccessModeValue) => {
    setHtmlSharePendingRequest(previous => previous ? { ...previous, accessMode } : previous);
    setHtmlShareDialog(previous => {
      if (
        !previous ||
        (previous.kind !== HtmlShareDialogKind.Create &&
          previous.kind !== HtmlShareDialogKind.Existing)
      ) {
        return previous;
      }
      return {
        ...previous,
        selectedAccessMode: accessMode,
        message: shouldUseHtmlShareCode(accessMode)
          ? t('htmlShareCodeViewHint')
          : t('htmlSharePublicViewHint'),
        statusError: undefined,
      };
    });
  }, []);

  const updateHtmlShare = useCallback(async (options?: { allowActiveLimitRestore?: boolean }) => {
    const allowActiveLimitRestore = options?.allowActiveLimitRestore === true;
    if (
      !htmlSharePendingRequest ||
      !htmlShareDialog?.shareId ||
      isHtmlSharing ||
      (isHtmlShareContentUpdateDisabled &&
        !(allowActiveLimitRestore && canRestoreActiveLimitDisabledHtmlShare))
    )
      return;
    const requestAccountGeneration = publishingAccountGenerationRef.current;
    const request = htmlSharePendingRequest;
    const shareId = htmlShareDialog.shareId;
    const currentStatus = htmlShareDialog.status;
    const accessMode = normalizeHtmlShareAccessMode(
      htmlShareDialog.selectedAccessMode ?? request.accessMode,
    );
    setHtmlShareDialog(previous => {
      if (
        !previous ||
        previous.kind !== HtmlShareDialogKind.Existing ||
        previous.shareId !== shareId
      ) {
        return previous;
      }
      return {
        ...previous,
        contentUpdateStatus: allowActiveLimitRestore
          ? previous.contentUpdateStatus
          : HtmlShareContentUpdateStatus.Updating,
        statusError: undefined,
      };
    });
    try {
      setHtmlSharePhase(HtmlSharePhase.Packing);
      setHtmlSharePhase(HtmlSharePhase.Uploading);
      window.electron?.log?.fromRenderer?.(
        'debug',
        'ArtifactPanel',
        `Updating ${request.sourceType} share for artifact ${request.artifactId}.`,
      );
      const result =
        request.source === HtmlSharePendingSource.HtmlFile
          ? await window.electron?.htmlShare?.updateFromHtmlFile({
              shareId,
              sessionId: request.sessionId,
              artifactId: request.artifactId,
              filePath: request.filePath || '',
              title: request.title,
              currentStatus,
              accessMode,
            })
          : await window.electron?.htmlShare?.updateFromArtifactFile({
              sourceType: request.sourceType,
              shareId,
              sessionId: request.sessionId,
              artifactId: request.artifactId,
              title: request.title,
              accessMode,
              fileName: request.fileName,
              filePath: request.filePath,
              content: request.content,
              remoteUrl: request.remoteUrl,
              currentStatus,
            });
      if (publishingAccountGenerationRef.current !== requestAccountGeneration) return;
      if (!result?.success || !result.url) {
        if (showPublishingQuotaDialog(result?.quota)) return;
        throw new Error(getHtmlShareFailureMessage(result));
      }
      const resultStatus = getConfigurableHtmlShareStatus(result.status) ?? HtmlShareStatus.Live;
      rememberHtmlShare(request.lookupKey, result);
      window.electron?.log?.fromRenderer?.(
        'debug',
        'ArtifactPanel',
        `Updated ${request.sourceType} share for artifact ${request.artifactId}.`,
      );
      setHtmlSharePhase(HtmlSharePhase.Live);
      setHtmlShareDialog(previous => {
        if (
          !previous ||
          previous.kind !== HtmlShareDialogKind.Existing ||
          previous.shareId !== shareId
        ) {
          return previous;
        }
        return {
          ...previous,
          message: shouldUseHtmlShareCode(result.accessMode ?? accessMode)
            ? t('htmlShareCodeViewHint')
            : t('htmlSharePublicViewHint'),
          url: result.url,
          accessMode: result.accessMode ?? accessMode,
          selectedAccessMode: result.accessMode ?? accessMode,
          shareCode: shouldUseHtmlShareCode(result.accessMode ?? accessMode)
            ? result.shareCode
            : undefined,
          shareCodeUnavailable: result.shareCodeUnavailable,
          status: resultStatus,
          targetStatus: resultStatus,
          disabledSource: result.disabledSource ?? undefined,
          accessExpiresAt: resolveAccessExpiresAt(result, previous.accessExpiresAt),
          subscriptionRecoveryMode: result.subscriptionRecoveryMode
            ?? previous.subscriptionRecoveryMode,
          statusError: undefined,
          contentUpdateStatus: allowActiveLimitRestore
            ? undefined
            : HtmlShareContentUpdateStatus.Complete,
        };
      });
    } catch (error) {
      if (publishingAccountGenerationRef.current !== requestAccountGeneration) return;
      setHtmlSharePhase(HtmlSharePhase.Failed);
      const message = error instanceof Error ? error.message : t('htmlShareFailed');
      window.electron?.log?.fromRenderer?.(
        'warn',
        'ArtifactPanel',
        `Failed to update ${request.sourceType} share for artifact ${request.artifactId}: ${message}`,
      );
      setHtmlShareDialog(previous => {
        if (
          !previous ||
          previous.kind !== HtmlShareDialogKind.Existing ||
          previous.shareId !== shareId
        ) {
          return {
            kind: HtmlShareDialogKind.Result,
            title: t('htmlShareFailed'),
            message,
          };
        }
        return {
          ...previous,
          statusError: message,
          contentUpdateStatus: HtmlShareContentUpdateStatus.Failed,
        };
      });
    }
  }, [
    htmlShareDialog?.shareId,
    htmlShareDialog?.status,
    htmlShareDialog?.selectedAccessMode,
    htmlSharePendingRequest,
    canRestoreActiveLimitDisabledHtmlShare,
    isHtmlShareContentUpdateDisabled,
    isHtmlSharing,
    rememberHtmlShare,
    showPublishingQuotaDialog,
  ]);

  const updateHtmlShareAccessMode = useCallback(async () => {
    if (
      !htmlSharePendingRequest ||
      !htmlShareDialog ||
      htmlShareDialog.kind !== HtmlShareDialogKind.Existing ||
      !htmlShareDialog.shareId ||
      isHtmlShareStatusUpdating
    ) {
      return;
    }
    const accessMode = normalizeHtmlShareAccessMode(
      htmlShareDialog.selectedAccessMode ?? htmlShareDialog.accessMode,
    );
    if (accessMode === normalizeHtmlShareAccessMode(htmlShareDialog.accessMode)) return;
    const shareId = htmlShareDialog.shareId;
    const request = htmlSharePendingRequest;
    const requestAccountGeneration = publishingAccountGenerationRef.current;
    setIsHtmlShareStatusUpdating(true);
    setHtmlShareDialog(previous => previous && previous.shareId === shareId
      ? { ...previous, statusError: undefined }
      : previous);
    try {
      const result = await window.electron?.htmlShare?.updateAccessMode({
        shareId,
        accessMode,
      });
      if (publishingAccountGenerationRef.current !== requestAccountGeneration) return;
      if (!result?.success || !result.url) {
        if (showPublishingQuotaDialog(result?.quota)) return;
        throw new Error(getHtmlShareFailureMessage(result));
      }
      const resultAccessMode = normalizeHtmlShareAccessMode(result.accessMode ?? accessMode);
      const refreshedShare = {
        shareId: result.shareId ?? shareId,
        url: result.url,
        accessMode: resultAccessMode,
        shareCode: shouldUseHtmlShareCode(resultAccessMode) ? result.shareCode : undefined,
        shareCodeUnavailable: result.shareCodeUnavailable,
        status: result.status ?? htmlShareDialog.status,
        disabledSource: result.disabledSource ?? htmlShareDialog.disabledSource,
        accessExpiresAt: resolveAccessExpiresAt(result, htmlShareDialog.accessExpiresAt),
        subscriptionRecoveryMode: result.subscriptionRecoveryMode
          ?? htmlShareDialog.subscriptionRecoveryMode,
      };
      rememberHtmlShare(request.lookupKey, refreshedShare);
      setHtmlShareDialog(previous => {
        if (
          !previous ||
          previous.kind !== HtmlShareDialogKind.Existing ||
          previous.shareId !== shareId
        ) {
          return previous;
        }
        return {
          ...previous,
          message: t('htmlShareAccessModeUpdateComplete'),
          url: refreshedShare.url,
          accessMode: resultAccessMode,
          selectedAccessMode: resultAccessMode,
          shareCode: refreshedShare.shareCode,
          shareCodeUnavailable: refreshedShare.shareCodeUnavailable,
          status: refreshedShare.status,
          targetStatus: getConfigurableHtmlShareStatus(refreshedShare.status),
          disabledSource: refreshedShare.disabledSource ?? undefined,
          accessExpiresAt: resolveAccessExpiresAt(refreshedShare, previous.accessExpiresAt),
          subscriptionRecoveryMode: refreshedShare.subscriptionRecoveryMode
            ?? previous.subscriptionRecoveryMode,
          statusError: undefined,
        };
      });
    } catch (error) {
      if (publishingAccountGenerationRef.current !== requestAccountGeneration) return;
      const message =
        error instanceof Error ? error.message : t('htmlShareAccessModeUpdateFailed');
      setHtmlShareDialog(previous => previous && previous.shareId === shareId
        ? { ...previous, statusError: message }
        : previous);
    } finally {
      if (publishingAccountGenerationRef.current === requestAccountGeneration) {
        setIsHtmlShareStatusUpdating(false);
      }
    }
  }, [
    htmlShareDialog,
    htmlSharePendingRequest,
    isHtmlShareStatusUpdating,
    rememberHtmlShare,
    showPublishingQuotaDialog,
  ]);

  const toggleHtmlShareTargetStatus = useCallback(async () => {
    if (
      !htmlShareDialog ||
      htmlShareDialog.kind !== HtmlShareDialogKind.Existing ||
      !htmlShareDialog.shareId ||
      !htmlShareDialog.targetStatus ||
      isHtmlShareStatusUpdating
    ) {
      return;
    }
    const shareId = htmlShareDialog.shareId;
    const previousStatus = htmlShareDialog.targetStatus;
    const requestAccountGeneration = publishingAccountGenerationRef.current;
    const nextStatus =
      previousStatus === HtmlShareStatus.Live ? HtmlShareStatus.Disabled : HtmlShareStatus.Live;
    const request = htmlSharePendingRequest;
    const restoreActiveLimitByUpdate =
      previousStatus === HtmlShareStatus.Disabled &&
      nextStatus === HtmlShareStatus.Live &&
      canRestoreActiveLimitDisabledHtmlShare;

    if (restoreActiveLimitByUpdate) {
      setIsHtmlShareStatusUpdating(true);
      try {
        await updateHtmlShare({ allowActiveLimitRestore: true });
      } finally {
        if (publishingAccountGenerationRef.current === requestAccountGeneration) {
          setIsHtmlShareStatusUpdating(false);
        }
      }
      return;
    }

    setIsHtmlShareStatusUpdating(true);
    setHtmlShareDialog(previous => {
      if (
        !previous ||
        previous.kind !== HtmlShareDialogKind.Existing ||
        previous.shareId !== shareId
      ) {
        return previous;
      }
      return {
        ...previous,
        status: nextStatus,
        targetStatus: nextStatus,
        statusError: undefined,
      };
    });
    try {
      const result = await window.electron?.htmlShare?.updateStatus({
        shareId,
        status: nextStatus,
      });
      if (publishingAccountGenerationRef.current !== requestAccountGeneration) return;
      if (!result?.success || !result.url) {
        if (showPublishingQuotaDialog(result?.quota)) return;
        throw new Error(getHtmlShareFailureMessage(result));
      }
      let refreshedShare: ExistingHtmlShareInfo | null = null;
      if (request) {
        try {
          const lookup =
            request.source === HtmlSharePendingSource.HtmlFile
              ? await window.electron?.htmlShare?.getByHtmlFile({
                  filePath: request.filePath || '',
                })
              : await window.electron?.htmlShare?.getByArtifactFile({
                  sourceType: request.sourceType,
                  sessionId: request.sessionId,
                  artifactId: request.artifactId,
                  filePath: request.filePath,
                });
          if (lookup?.success) {
            refreshedShare = getExistingHtmlShareInfo(lookup.share);
          }
        } catch {
          refreshedShare = null;
        }
      }
      if (publishingAccountGenerationRef.current !== requestAccountGeneration) return;
      const resultStatus =
        getConfigurableHtmlShareStatus(refreshedShare?.status ?? result.status) ?? nextStatus;
      const refreshedResult = {
        shareId: refreshedShare?.shareId ?? result.shareId ?? shareId,
        url: refreshedShare?.url ?? result.url,
        accessMode: refreshedShare?.accessMode ?? result.accessMode ?? htmlShareDialog.accessMode,
        shareCode: refreshedShare?.shareCode ?? result.shareCode,
        shareCodeUnavailable:
          refreshedShare?.shareCodeUnavailable ?? result.shareCodeUnavailable,
        status: resultStatus,
        disabledSource: refreshedShare?.disabledSource ?? result.disabledSource,
        accessExpiresAt: resolveAccessExpiresAt(
          refreshedShare,
          resolveAccessExpiresAt(result, htmlShareDialog.accessExpiresAt),
        ),
        subscriptionRecoveryMode: refreshedShare?.subscriptionRecoveryMode
          ?? result.subscriptionRecoveryMode
          ?? htmlShareDialog.subscriptionRecoveryMode,
      };
      if (request) {
        rememberHtmlShare(request.lookupKey, refreshedResult);
      }
      setHtmlShareDialog(previous => {
        if (
          !previous ||
          previous.kind !== HtmlShareDialogKind.Existing ||
          previous.shareId !== shareId
        ) {
          return previous;
        }
        return {
          ...previous,
          url: refreshedResult.url ?? previous.url,
          accessMode: refreshedResult.accessMode ?? previous.accessMode,
          selectedAccessMode: refreshedResult.accessMode ?? previous.selectedAccessMode,
          shareCode: shouldUseHtmlShareCode(refreshedResult.accessMode ?? previous.accessMode)
            ? refreshedResult.shareCode ?? previous.shareCode
            : undefined,
          shareCodeUnavailable:
            refreshedResult.shareCodeUnavailable ?? previous.shareCodeUnavailable,
          status: resultStatus,
          targetStatus: resultStatus,
          disabledSource: refreshedResult.disabledSource ?? undefined,
          accessExpiresAt: resolveAccessExpiresAt(refreshedResult, previous.accessExpiresAt),
          subscriptionRecoveryMode: refreshedResult.subscriptionRecoveryMode
            ?? previous.subscriptionRecoveryMode,
          statusError: undefined,
        };
      });
    } catch (error) {
      if (publishingAccountGenerationRef.current !== requestAccountGeneration) return;
      const message =
        error instanceof Error ? error.message : t('htmlShareStatusUpdateFailed');
      setHtmlShareDialog(previous => {
        if (
          !previous ||
          previous.kind !== HtmlShareDialogKind.Existing ||
          previous.shareId !== shareId
        ) {
          return previous;
        }
        return {
          ...previous,
          status: previousStatus,
          targetStatus: previousStatus,
          statusError: message,
        };
      });
    } finally {
      if (publishingAccountGenerationRef.current === requestAccountGeneration) {
        setIsHtmlShareStatusUpdating(false);
      }
    }
  }, [
    htmlShareDialog,
    htmlSharePendingRequest,
    canRestoreActiveLimitDisabledHtmlShare,
    isHtmlShareStatusUpdating,
    rememberHtmlShare,
    showPublishingQuotaDialog,
    updateHtmlShare,
  ]);

  const handleOpenWithApp = useCallback(() => {
    if (selectedArtifact?.filePath) {
      void openLocalPathWithToast(normalizeShellFilePath(selectedArtifact.filePath));
    }
  }, [selectedArtifact]);

  const handleRefresh = useCallback(async () => {
    if (!selectedArtifact?.filePath) return;
    if (selectedArtifact.type === 'video') {
      dispatch(addArtifact({
        sessionId: selectedArtifact.sessionId,
        artifact: { ...selectedArtifact, createdAt: Date.now() },
      }));
      return;
    }
    try {
      if (await refreshOpenOfficeEditor(selectedArtifact.filePath)) return;
      if (selectedArtifact.type === ArtifactTypeValue.Html) {
        dispatch(addArtifact({
          sessionId: selectedArtifact.sessionId,
          artifact: {
            ...selectedArtifact,
            contentVersion: Date.now(),
          },
        }));
        return;
      }

      const isTextType = selectedArtifact.type !== 'image' && selectedArtifact.type !== 'document';
      if (isTextType && window.electron?.dialog?.readTextFile) {
        const result = await window.electron.dialog.readTextFile(selectedArtifact.filePath);
        if (result?.truncated) {
          logArtifactFileActionFailure(
            'refresh artifact source',
            `file exceeds read limit; size=${result.size ?? 'unknown'}, readBytes=${result.readBytes ?? 'unknown'}`,
          );
          window.dispatchEvent(new CustomEvent('app:showToast', {
            detail: t('artifactSourceTooLarge'),
          }));
          return;
        }
        if (result?.success && typeof result.content === 'string') {
          dispatch(addArtifact({
            sessionId: selectedArtifact.sessionId,
            artifact: { ...selectedArtifact, content: result.content, contentVersion: Date.now() },
          }));
        } else {
          logArtifactFileActionFailure('refresh artifact source', result?.error);
          window.dispatchEvent(new CustomEvent('app:showToast', {
            detail: result?.error || t('artifactSourceLoadFailed'),
          }));
        }
        return;
      }

      const result = await window.electron.dialog.readFileAsDataUrl(selectedArtifact.filePath);
      if (result?.success && result.dataUrl) {
        const isTextType =
          selectedArtifact.type !== 'image' && selectedArtifact.type !== 'document';
        let content = result.dataUrl;
        if (isTextType) {
          try {
            const base64 = result.dataUrl.split(',')[1] || '';
            const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
            content = new TextDecoder('utf-8').decode(bytes);
          } catch {
            content = result.dataUrl;
          }
        }
        dispatch(
          addArtifact({
            sessionId: selectedArtifact.sessionId,
            artifact: { ...selectedArtifact, content },
          }),
        );
      } else {
        logArtifactFileActionFailure('refresh artifact preview', result?.error);
        window.dispatchEvent(new CustomEvent('app:showToast', {
          detail: result?.error || t('artifactSourceLoadFailed'),
        }));
      }
    } catch (error) {
      logArtifactFileActionFailure('refresh artifact preview', error);
      window.dispatchEvent(new CustomEvent('app:showToast', {
        detail: t('artifactSourceLoadFailed'),
      }));
    }
  }, [selectedArtifact, dispatch]);

  const handleRefreshRef = useRef(handleRefresh);
  handleRefreshRef.current = handleRefresh;

  const runArtifactMenuAction = useCallback((action: () => void) => {
    setIsArtifactActionsMenuOpen(false);
    action();
  }, []);

  const isHtmlShareLinkDialog = Boolean(
    htmlShareDialog &&
      (htmlShareDialog.kind === HtmlShareDialogKind.Create ||
        htmlShareDialog.kind === HtmlShareDialogKind.Existing ||
        (htmlShareDialog.kind === HtmlShareDialogKind.Result && htmlShareDialog.url)),
  );
  const isHtmlShareCreateDialog =
    htmlShareDialog?.kind === HtmlShareDialogKind.Create;
  const isHtmlShareExistingDialog =
    htmlShareDialog?.kind === HtmlShareDialogKind.Existing;
  const htmlShareTrialStatus = usePublishingTrialStatus(htmlShareDialog?.accessExpiresAt);
  const isHtmlShareStoppedDialog =
    isHtmlShareExistingDialog &&
    (htmlShareTrialStatus.isExpired || htmlShareDialog.targetStatus === HtmlShareStatus.Disabled);
  const isHtmlShareActiveLimitStoppedDialog =
    isHtmlShareStoppedDialog &&
    !htmlShareTrialStatus.isExpired &&
    htmlShareDialog.disabledSource === HtmlShareDisabledSource.ActiveLimit;
  const htmlShareStoppedNotice =
    !isHtmlShareStoppedDialog
      ? undefined
      : htmlShareTrialStatus.isExpired
        ? t('htmlShareStoppedNotice')
        : htmlShareDialog.disabledSource === HtmlShareDisabledSource.ActiveLimit
        ? t('htmlShareStoppedByActiveLimitNotice')
        : htmlShareDialog.disabledSource === HtmlShareDisabledSource.Admin
          ? t('htmlShareStoppedByAdminNotice')
          : htmlShareDialog.disabledSource === HtmlShareDisabledSource.Moderation
            ? t('htmlShareStoppedByModerationNotice')
            : t('htmlShareStoppedNotice');
  const isHtmlShareFileUpdateDisabled =
    htmlShareTrialStatus.isExpired || isHtmlSharing || isHtmlShareContentUpdateDisabled;
  const htmlShareUpdateActionLabel = t('htmlShareUpdate');
  const htmlShareSelectedAccessMode = normalizeHtmlShareAccessMode(
    htmlShareDialog?.selectedAccessMode ?? htmlShareDialog?.accessMode,
  );
  const canShowHtmlShareAccessModeControls =
    isHtmlShareCreateDialog || isHtmlShareExistingDialog;
  const isHtmlShareAccessModeChanged =
    isHtmlShareExistingDialog &&
    canShowHtmlShareAccessModeControls &&
    htmlShareSelectedAccessMode !== normalizeHtmlShareAccessMode(htmlShareDialog?.accessMode);
  const isHtmlShareAccessModeActionDisabled = Boolean(
    htmlShareTrialStatus.isExpired
      || !isHtmlShareAccessModeChanged
      || isHtmlShareStatusUpdating
      || isHtmlSharing,
  );
  const canShowHtmlShareDialogCopyAction = Boolean(
    canUseHtmlShareDialogLink && !isHtmlShareAccessModeChanged,
  );
  const isHtmlShareAvailabilityActionDisabled = Boolean(
    htmlShareTrialStatus.isExpired ||
      !htmlShareDialog?.shareId ||
      isHtmlShareStatusUpdating ||
      isHtmlSharing ||
      !htmlShareDialog.targetStatus,
  );
  const htmlShareAvailabilityActionLabel =
    htmlShareDialog?.targetStatus === HtmlShareStatus.Disabled
      ? t('htmlShareStartSharing')
      : t('htmlShareStopSharing');
  const htmlShareAvailabilityActionClassName = isHtmlShareStoppedDialog
    ? 'inline-flex h-10 min-w-[96px] items-center justify-center whitespace-nowrap rounded-lg bg-primary px-4 text-base text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60'
    : 'inline-flex h-10 min-w-[96px] items-center justify-center whitespace-nowrap rounded-lg border border-border bg-background px-4 text-base text-secondary transition-colors hover:bg-surface hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60';
  const htmlShareCopyButtonLabel =
    htmlShareCopyStatus === HtmlShareCopyStatus.Failed
      ? t('copyFailed')
      : htmlShareCopyStatus === HtmlShareCopyStatus.Copied
        ? t('copied')
        : shouldUseHtmlShareCode(htmlShareDialog?.accessMode) && htmlShareDialog?.shareCode
          ? t('htmlShareCopyLinkAndCode')
          : t('htmlShareCopyLink');
  const browserPublishAction: BrowserPublishAction | undefined = (() => {
    if (browserToolbarPublishTarget?.kind === ArtifactToolbarPublishActionKind.Share) {
      return {
        kind: ArtifactToolbarPublishActionKind.Share,
        label: t('htmlShare'),
        disabled: false,
        busy: false,
        onClick: handleShareBrowserHtmlArtifact,
      };
    }
    return undefined;
  })();

  return (
    <>
      {/* Drag handle */}
      {!isPanelExpanded && (
        <div
          key="artifact-panel-resize-handle"
          className="w-1 shrink-0 touch-none cursor-col-resize transition-colors hover:bg-primary/30 active:bg-primary/50"
          onPointerDown={handleResizeStart}
        />
      )}
      {/* The key preserves the preview subtree when the preceding drag handle is removed. */}
      <aside
        key="artifact-panel-content"
        style={isPanelExpanded
          ? { width: '100%', maxWidth: 'none' }
          : { width: constrainedPanelWidth, maxWidth: constrainedMaxPanelWidth }}
        className={`${selectedArtifact && isWorkspaceDiffArtifact(selectedArtifact) ? 'bg-white dark:bg-[#181818]' : 'bg-background'} flex flex-col h-full overflow-hidden relative ${
          isPanelExpanded ? 'min-w-0 flex-1' : 'shrink border-l border-border'
        }`}
      >
        {!isPanelExpanded && panelIsResizing && (
          <div className="absolute inset-0 z-30 cursor-col-resize bg-transparent" />
        )}

        {selectedArtifact ? (
          <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden">
            {/* Header: current file + actions. A workspace review owns its toolbar and file tree. */}
            {!isWorkspaceDiffArtifact(selectedArtifact) && <div className="h-10 flex items-center gap-2 px-3 border-b border-border shrink-0">
              <span className="text-sm font-medium truncate">
                {selectedArtifact.fileName || selectedArtifact.title}
              </span>
              <span className="flex-1" />
              {artifactToolbarPublishTarget && (
                <button
                  type="button"
                  onClick={handleShareSelectedArtifact}
                  className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-secondary transition-colors hover:bg-surface hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45"
                  aria-label={t('htmlShare')}
                  title={t('htmlShare')}
                >
                  <ShareUploadIcon />
                </button>
              )}
              {showArtifactActionsMenu && (
                <div className="relative">
                  <button
                    ref={artifactActionsMenuButtonRef}
                    type="button"
                    onClick={() => setIsArtifactActionsMenuOpen(value => {
                      const nextOpen = !value;
                      return nextOpen;
                    })}
                    className={`p-1 rounded transition-colors ${
                      isArtifactActionsMenuOpen
                        ? 'bg-surface text-foreground'
                        : 'text-secondary hover:text-foreground hover:bg-surface'
                    }`}
                    aria-label={t('artifactActionsMenu')}
                    title={t('artifactActionsMenu')}
                  >
                    <MoreHorizontalToolbarIcon />
                  </button>
                  {isArtifactActionsMenuOpen && (
                    <div
                      ref={artifactActionsMenuRef}
                      className="absolute right-0 top-7 z-40 w-44 rounded-lg border border-border bg-surface-raised p-1.5 text-sm text-foreground shadow-xl"
                    >
                      {showContentViewActionInMenu && (
                        <button
                          type="button"
                          onClick={() => runArtifactMenuAction(() => handleSetContentView(contentViewActionTarget))}
                          className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs transition-colors hover:bg-surface"
                        >
                          <ContentViewIcon />
                          <span>{contentViewActionLabel}</span>
                        </button>
                      )}
                      {showRefreshAction && (
                        <button
                          type="button"
                          onClick={() => runArtifactMenuAction(handleRefresh)}
                          className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs transition-colors hover:bg-surface"
                        >
                          <RefreshIcon />
                          <span>{t('artifactRefresh')}</span>
                        </button>
                      )}
                      {showCopyAction && (
                        <button
                          type="button"
                          onClick={() => runArtifactMenuAction(() => void handleCopy())}
                          className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs transition-colors hover:bg-surface"
                        >
                          <CopyIcon className="h-3.5 w-3.5" />
                          <span>{t('artifactCopyCode')}</span>
                        </button>
                      )}
                      {showOpenBrowserActionInMenu && (
                        <button
                          type="button"
                          onClick={() => runArtifactMenuAction(handleOpenInBrowser)}
                          className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs transition-colors hover:bg-surface"
                        >
                          <BrowserIcon />
                          <span>{t('artifactOpenInBrowser')}</span>
                        </button>
                      )}
                      {showOpenWithAppActionInMenu && (
                        <button
                          type="button"
                          onClick={() => runArtifactMenuAction(handleOpenWithApp)}
                          className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs transition-colors hover:bg-surface"
                        >
                          <OpenExternalIcon />
                          <span>{t('artifactOpenWithApp')}</span>
                        </button>
                      )}
                      {showRevealInFolderActionInMenu && (
                        <button
                          type="button"
                          onClick={() => runArtifactMenuAction(handleRevealInFolder)}
                          className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs transition-colors hover:bg-surface"
                        >
                          <FolderIcon />
                          <span>{t('artifactOpenFolder')}</span>
                        </button>
                      )}
                      {officePreviewZoomControls && (
                        <div
                          className={`${hasArtifactActionMenuItems ? 'mt-1 border-t border-border/70 pt-1.5' : ''} px-1 py-1`}
                        >
                          <div className="flex h-8 items-center gap-1.5">
                            <span className="shrink-0 whitespace-nowrap text-xs text-secondary">
                              {t('artifactBrowserZoom')}
                            </span>
                            <OfficeZoomControls
                              zoomFactor={officePreviewZoomControls.zoomFactor}
                              displayZoomFactor={officePreviewZoomControls.displayZoomFactor}
                              onZoomOut={officePreviewZoomControls.onZoomOut}
                              onZoomIn={officePreviewZoomControls.onZoomIn}
                              onResetZoom={officePreviewZoomControls.onResetZoom}
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
              {isCompactHtmlToolbar && showOpenBrowserAction && (
                <button
                  onClick={handleOpenInBrowser}
                  className="p-1 rounded text-secondary hover:text-foreground hover:bg-surface transition-colors"
                  title={t('artifactOpenInBrowser')}
                >
                  <OpenExternalIcon />
                </button>
              )}
              {showPrimaryOpenWithAppAction && (
                <button
                  onClick={handleOpenWithApp}
                  className="p-1 rounded text-secondary hover:text-foreground hover:bg-surface transition-colors"
                  title={t('artifactOpenWithApp')}
                >
                  <OpenExternalIcon />
                </button>
              )}
              {showPrimaryRevealInFolderAction && (
                <button
                  onClick={handleRevealInFolder}
                  className="p-1 rounded text-secondary hover:text-foreground hover:bg-surface transition-colors"
                  title={t('artifactOpenFolder')}
                >
                  <FolderIcon />
                </button>
              )}
              <button
                ref={fileListButtonRef}
                onClick={toggleFileListDrawer}
                className={`p-1 rounded transition-colors ${
                  isFileListDrawerVisible
                    ? 'text-primary bg-primary/10'
                    : 'text-secondary hover:text-foreground hover:bg-surface'
                }`}
                title={t('artifactFileList')}
              >
                <FileListIcon />
              </button>
            </div>}

            {showFileListDrawer && !isWorkspaceDiffArtifact(selectedArtifact) && (
              <div
                ref={fileListDrawerRef}
                className={`absolute top-10 right-0 bottom-0 z-20 flex w-[min(320px,86%)] flex-col border-l border-border bg-background shadow-xl transition-[transform,opacity] duration-[180ms] ease-out motion-reduce:transition-none ${
                  isFileListDrawerVisible
                    ? 'translate-x-0 opacity-100'
                    : 'translate-x-full opacity-0 pointer-events-none'
                }`}
              >
                <div className="h-9 flex items-center px-3 border-b border-border shrink-0">
                  <span className="text-xs font-medium text-secondary">
                    {t('artifactFileList')}
                  </span>
                </div>
                <FileDirectoryView
                  artifacts={previewableArtifacts}
                  selectedId={selectedArtifactId}
                  onSelect={handleSelectArtifactFromDrawer}
                  compact
                />
              </div>
            )}

            {/* Render area */}
            <div className="flex-1 min-h-0 overflow-hidden">
              <OfficePreviewActionsContext.Provider value={officePreviewActionsContextValue}>
                <ArtifactRenderer
                  artifact={selectedArtifact}
                  sessionArtifacts={artifacts}
                  selectedTextContext={selectedTextContext}
                  sourceView={isCodeViewActive}
                />
              </OfficePreviewActionsContext.Provider>
            </div>
          </div>
        ) : activeSpecialTab === ArtifactSpecialTab.Browser ? (
          <BrowserTabContent
            address={browserAddress}
            currentUrl={browserUrl}
            sessionArtifacts={artifacts}
            autoRefreshFilePath={browserHtmlAutoRefreshFilePath}
            localHtmlPreviewUrl={browserHtmlPreviewUrl}
            onAddressChange={handleBrowserAddressChange}
            onCurrentUrlChange={handleBrowserUrlChange}
            onTitleChange={onBrowserTitleChange}
            publishAction={browserPublishAction}
            draftKey={sessionId}
            annotationBatch={browserAnnotationBatch}
            onAnnotationBatchChange={batch => {
              if (batch) {
                dispatch(upsertDraftBrowserAnnotationBatch({ draftKey: sessionId, batch }));
              } else if (browserAnnotationBatch) {
                dispatch(removeDraftBrowserAnnotationBatch({
                  draftKey: sessionId,
                  batchId: browserAnnotationBatch.id,
                }));
              }
            }}
            annotationSendCount={annotationSendCount}
            onAnnotationSend={onAnnotationSend}
          />
        ) : activeSpecialTab === ArtifactSpecialTab.AgentBrowser && agentBrowserPanel ? (
          agentBrowserPanel
        ) : activeSpecialTab === ArtifactSpecialTab.Subagents && subagentPanel ? (
          subagentPanel
        ) : activeSpecialTab === ArtifactSpecialTab.UserAttachment && userAttachmentPanel ? (
          userAttachmentPanel
        ) : (
          /* No artifact selected: show full-width file list */
          <div className="flex-1 flex flex-col h-full overflow-hidden">
            <FileDirectoryView
              artifacts={previewableArtifacts}
              selectedId={selectedArtifactId}
              onSelect={handleSelectArtifact}
            />
          </div>
        )}
      </aside>
      {htmlShareDialog &&
        createPortal(
          <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/35 px-4">
            {isHtmlShareLinkDialog ? (
              <div className="relative w-full max-w-[420px] rounded-2xl bg-background px-7 pb-6 pt-6 shadow-2xl">
                <button
                  type="button"
                  onClick={() => {
                    setHtmlShareDialog(null);
                    setHtmlSharePendingRequest(null);
                  }}
                  className="absolute right-6 top-6 rounded-md p-1 text-muted transition-colors hover:bg-surface hover:text-foreground"
                  aria-label={t('close')}
                  title={t('close')}
                >
                  <CloseIcon />
                </button>
                <div className="flex min-w-0 flex-wrap items-center gap-3 pr-8">
                  <div className="text-xl font-semibold leading-7 text-foreground">
                    {t('htmlShare')}
                  </div>
                  <PublishingTrialStatus status={htmlShareTrialStatus} />
                </div>
                {isHtmlShareStoppedDialog ? (
                  <div
                    className={
                      isHtmlShareActiveLimitStoppedDialog
                        ? 'mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm leading-5 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200'
                        : 'mt-2 text-sm font-medium leading-5 text-red-500'
                    }
                  >
                    {htmlShareStoppedNotice}
                  </div>
                ) : (
                  <div className="mt-3 text-sm leading-5 text-muted">
                    {htmlShareDialog.message}
                  </div>
                )}

                {canShowHtmlShareAccessModeControls && (
                  <div className="mt-5">
                    <div className="mb-2 text-sm font-medium text-foreground">
                      {t('htmlShareAccessMode')}
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      {[
                        {
                          mode: HtmlShareAccessMode.Code,
                          label: t('htmlShareAccessModeCode'),
                          hint: t('htmlShareAccessModeCodeHint'),
                        },
                        {
                          mode: HtmlShareAccessMode.Public,
                          label: t('htmlShareAccessModePublic'),
                          hint: t('htmlShareAccessModePublicHint'),
                        },
                      ].map(option => {
                        const isSelected = htmlShareSelectedAccessMode === option.mode;
                        return (
                          <button
                            key={option.mode}
                            type="button"
                            onClick={() => selectHtmlShareAccessMode(option.mode)}
                            disabled={
                              htmlShareTrialStatus.isExpired
                              || isHtmlSharing
                              || isHtmlShareStatusUpdating
                            }
                            className={`min-h-[82px] rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                              isSelected
                                ? 'border-primary bg-primary/10 text-foreground'
                                : 'border-border bg-surface text-secondary hover:border-primary/40 hover:text-foreground'
                            }`}
                          >
                            <span className="block text-sm font-medium leading-5">
                              {option.label}
                            </span>
                            <span className="mt-1 block text-xs leading-4 text-muted">
                              {option.hint}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {htmlShareDialog.url && (
                  <div className="mt-5 rounded-sm border border-[#edf0f4] bg-[#f5f6f8] px-4 py-4 dark:border-white/10 dark:bg-white/5">
                    <div className="min-w-0 break-words text-base leading-6 text-foreground">
                      {htmlShareDialog.url}
                    </div>
                    {shouldUseHtmlShareCode(htmlShareDialog.accessMode) && htmlShareDialog.shareCode && (
                      <div className="mt-4 text-base leading-6 text-foreground">
                        <span className="text-muted">{t('htmlShareCode')}</span>
                        <span className="ml-2 font-medium">{htmlShareDialog.shareCode}</span>
                      </div>
                    )}
                  </div>
                )}

                {shouldUseHtmlShareCode(htmlShareDialog.accessMode) &&
                  htmlShareDialog.shareCodeUnavailable && (
                  <div className="mt-3 text-xs leading-5 text-muted">
                    {t('htmlShareCodeUnavailable')}
                  </div>
                )}
                {isHtmlShareExistingDialog && htmlShareDialog.statusError && (
                  <div className="mt-3 text-xs leading-5 text-red-500">
                    {htmlShareDialog.statusError}
                  </div>
                )}

                {isHtmlShareExistingDialog && (
                  <div className="mt-5">
                    <div className="flex items-center gap-2">
                      <span className="text-base font-medium text-foreground">
                        {t('htmlShareUpdateFile')}
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          void updateHtmlShare();
                        }}
                        disabled={isHtmlShareFileUpdateDisabled}
                        title={
                          htmlShareDialog.targetStatus === HtmlShareStatus.Disabled &&
                          !canRestoreActiveLimitDisabledHtmlShare
                            ? t('htmlShareDisabledCannotUpdate')
                            : htmlShareDialog.targetStatus === HtmlShareStatus.Disabled
                              ? t('htmlShareActiveLimitCannotUpdate')
                            : undefined
                        }
                        className="inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-sm text-secondary transition-colors hover:bg-surface hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        <RefreshIcon />
                        {htmlShareUpdateActionLabel}
                      </button>
                    </div>
                    {htmlShareDialog.contentUpdateStatus &&
                      htmlShareDialog.contentUpdateStatus !==
                        HtmlShareContentUpdateStatus.Failed && (
                        <span className="text-sm text-muted">
                          {htmlShareDialog.contentUpdateStatus ===
                          HtmlShareContentUpdateStatus.Updating
                            ? t('htmlShareUpdatingFile')
                            : t('htmlShareUpdateComplete')}
                        </span>
                      )}
                  </div>
                )}

                <div className="mt-12 flex flex-wrap items-center justify-end gap-3">
                  {isHtmlShareCreateDialog && (
                    <button
                      type="button"
                      onClick={() => {
                        if (htmlSharePendingRequest) {
                          void createHtmlShare({
                            ...htmlSharePendingRequest,
                            accessMode: htmlShareSelectedAccessMode,
                          });
                        }
                      }}
                      disabled={isHtmlSharing || !htmlSharePendingRequest}
                      className="inline-flex h-10 min-w-[104px] items-center justify-center whitespace-nowrap rounded-lg bg-primary px-4 text-base text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {isHtmlSharing ? t('htmlShareUploading') : t('htmlShareCreateAction')}
                    </button>
                  )}
                  {isHtmlShareExistingDialog && (
                    <button
                      type="button"
                      onClick={toggleHtmlShareTargetStatus}
                      disabled={isHtmlShareAvailabilityActionDisabled}
                      className={htmlShareAvailabilityActionClassName}
                    >
                      {isHtmlShareStatusUpdating
                        ? t('htmlShareStatusUpdating')
                        : htmlShareAvailabilityActionLabel}
                    </button>
                  )}
                  {isHtmlShareExistingDialog && isHtmlShareAccessModeChanged && (
                    <button
                      type="button"
                      onClick={updateHtmlShareAccessMode}
                      disabled={isHtmlShareAccessModeActionDisabled}
                      className="inline-flex h-10 min-w-[128px] items-center justify-center whitespace-nowrap rounded-lg bg-primary px-4 text-base text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {isHtmlShareStatusUpdating
                        ? t('htmlShareAccessModeUpdating')
                        : t('htmlShareAccessModeUpdateAction')}
                    </button>
                  )}
                  {canShowHtmlShareDialogCopyAction && (
                    <button
                      type="button"
                      onClick={() =>
                        handleCopyShareLink(
                          htmlShareDialog.url,
                          shouldUseHtmlShareCode(htmlShareDialog.accessMode)
                            ? htmlShareDialog.shareCode
                            : undefined,
                        )
                      }
                      className={`inline-flex h-10 min-w-[104px] items-center justify-center whitespace-nowrap rounded-lg px-4 text-base transition-colors ${
                        htmlShareCopyStatus === HtmlShareCopyStatus.Failed
                          ? 'bg-red-500 text-white hover:bg-red-500/90'
                          : 'bg-primary text-primary-foreground hover:bg-primary/90'
                      }`}
                    >
                      {htmlShareCopyButtonLabel}
                    </button>
                  )}
                </div>
              </div>
              ) : (
              <div className="w-full max-w-[420px] rounded-lg border border-border bg-background p-4 shadow-2xl">
                <div className="text-sm font-semibold text-foreground">
                  {htmlShareDialog.title}
                </div>
                <div className="mt-3 space-y-3">
                  <div className="whitespace-pre-wrap break-words text-sm leading-6 text-secondary">
                    {htmlShareDialog.message}
                  </div>
                </div>
                <div className="mt-4 flex flex-wrap justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setHtmlShareDialog(null);
                      setHtmlSharePendingRequest(null);
                    }}
                    className="rounded-md border border-border px-3 py-1.5 text-sm text-secondary transition-colors hover:bg-surface hover:text-foreground"
                  >
                    {htmlShareDialog.kind === HtmlShareDialogKind.Result ? t('close') : t('cancel')}
                  </button>
                </div>
              </div>
            )}
          </div>,
          document.body,
        )}
      {publishingQuotaDialog && (
        <PublishingQuotaLimitDialog
          quota={publishingQuotaDialog}
          onClose={closePublishingQuotaDialog}
          onSubscribe={openSubscriptionPage}
          onLearnBenefits={openSubscriptionPage}
          onManage={() => {
            closePublishingQuotaDialog();
            window.dispatchEvent(new Event(LibraryNavigationEvent.OpenCloud));
          }}
        />
      )}
    </>
  );
};

type BrowserWebviewElement = HTMLElement & {
  canGoBack?: () => boolean;
  canGoForward?: () => boolean;
  capturePage?: () => Promise<{
    toDataURL: () => string;
    getSize?: () => { width: number; height: number };
  }>;
  executeJavaScript?: (code: string) => Promise<unknown>;
  loadURL?: (url: string) => Promise<void>;
  goBack?: () => void;
  goForward?: () => void;
  reload?: () => void;
  stop?: () => void;
  getURL?: () => string;
  getTitle?: () => string;
  getZoomFactor?: () => number;
  setZoomFactor?: (factor: number) => void;
  send?: (channel: string, ...args: unknown[]) => void;
};

const BrowserScreenshotStatus = {
  Idle: 'idle',
  Copied: 'copied',
  Error: 'error',
} as const;

type BrowserScreenshotStatus =
  (typeof BrowserScreenshotStatus)[keyof typeof BrowserScreenshotStatus];

export const BrowserAnnotationStatus = {
  Sent: 'sent',
  Cancelled: 'cancelled',
} as const;

export type BrowserAnnotationStatus =
  (typeof BrowserAnnotationStatus)[keyof typeof BrowserAnnotationStatus];

const BrowserToolbarAction = {
  Annotate: 'annotate',
  OpenExternal: 'openExternal',
} as const;

type BrowserToolbarAction = (typeof BrowserToolbarAction)[keyof typeof BrowserToolbarAction];

const BrowserZoom = {
  Min: 0.25,
  Max: 3,
  Step: 0.1,
  Default: 1,
} as const;

const BrowserPageUrl = {
  Blank: 'about:blank',
} as const;

const LocalServiceDisplay = {
  Limit: 10,
} as const;

function getBrowserTitleBaseName(value: string | undefined): string {
  if (!value) return '';
  let source = value.trim();
  if (!source) return '';
  try {
    const url = new URL(source);
    source = decodeURIComponent(url.pathname || source);
  } catch {
    source = source.split(/[?#]/, 1)[0] ?? source;
  }
  if (source.startsWith('file:///')) {
    source = source.slice(7);
  } else if (source.startsWith('file://')) {
    source = source.slice(7);
  }
  const lastSlash = Math.max(source.lastIndexOf('/'), source.lastIndexOf('\\'));
  return lastSlash >= 0 ? source.slice(lastSlash + 1) : source;
}

function normalizeBrowserPageTitle(
  title: string | undefined,
  pageUrl: string | undefined,
  address: string | undefined,
): string {
  const normalizedTitle = title?.trim() ?? '';
  if (!normalizedTitle) return '';
  const lowerTitle = normalizedTitle.toLowerCase();
  const fallbackSources = [pageUrl, address].map(value => value?.trim().toLowerCase() ?? '').filter(Boolean);
  if (fallbackSources.includes(lowerTitle)) return '';
  const fallbackFileNames = [getBrowserTitleBaseName(pageUrl), getBrowserTitleBaseName(address)]
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);
  if (fallbackFileNames.includes(lowerTitle)) return '';
  if (
    /[/\\]/.test(normalizedTitle) &&
    fallbackFileNames.includes(getBrowserTitleBaseName(normalizedTitle).trim().toLowerCase())
  ) {
    return '';
  }
  return normalizedTitle;
}

const BrowserDevicePresetId = {
  Responsive: 'responsive',
  FourK: '4k',
  LaptopLarge: 'laptop-large',
  Laptop: 'laptop',
  SurfacePro7: 'surface-pro-7',
  IPadAir: 'ipad-air',
  IPadMini: 'ipad-mini',
  SurfaceDuo: 'surface-duo',
  IPhone15ProMax: 'iphone-15-pro-max',
  Pixel8: 'pixel-8',
  IPhone15Pro: 'iphone-15-pro',
  SamsungGalaxyS24Ultra: 'samsung-galaxy-s24-ultra',
  IPhoneSe: 'iphone-se',
} as const;

type BrowserDevicePresetId = (typeof BrowserDevicePresetId)[keyof typeof BrowserDevicePresetId];

interface BrowserDevicePreset {
  id: BrowserDevicePresetId;
  labelKey?: string;
  label?: string;
  width: number;
  height: number;
}

const BrowserDeviceViewport = {
  MinSize: 50,
  MaxSize: 9999,
  DefaultWidth: 880,
  DefaultHeight: 888,
} as const;

const BrowserDeviceScale = {
  Min: 0.25,
  Max: 2,
  Default: 1,
} as const;

const BROWSER_DEVICE_PRESETS: BrowserDevicePreset[] = [
  {
    id: BrowserDevicePresetId.Responsive,
    labelKey: 'artifactBrowserDeviceResponsive',
    width: BrowserDeviceViewport.DefaultWidth,
    height: BrowserDeviceViewport.DefaultHeight,
  },
  { id: BrowserDevicePresetId.FourK, label: '4K', width: 3840, height: 2160 },
  { id: BrowserDevicePresetId.LaptopLarge, label: 'Laptop L', width: 1440, height: 900 },
  {
    id: BrowserDevicePresetId.Laptop,
    labelKey: 'artifactBrowserDeviceLaptop',
    width: 1366,
    height: 768,
  },
  { id: BrowserDevicePresetId.SurfacePro7, label: 'Surface Pro 7', width: 912, height: 1368 },
  { id: BrowserDevicePresetId.IPadAir, label: 'iPad Air', width: 820, height: 1180 },
  { id: BrowserDevicePresetId.IPadMini, label: 'iPad Mini', width: 768, height: 1024 },
  { id: BrowserDevicePresetId.SurfaceDuo, label: 'Surface Duo', width: 540, height: 720 },
  { id: BrowserDevicePresetId.IPhone15ProMax, label: 'iPhone 15 Pro Max', width: 430, height: 932 },
  { id: BrowserDevicePresetId.Pixel8, label: 'Pixel 8', width: 412, height: 915 },
  { id: BrowserDevicePresetId.IPhone15Pro, label: 'iPhone 15 Pro', width: 393, height: 852 },
  {
    id: BrowserDevicePresetId.SamsungGalaxyS24Ultra,
    label: 'Samsung Galaxy S24 Ultra',
    width: 384,
    height: 824,
  },
  { id: BrowserDevicePresetId.IPhoneSe, label: 'iPhone SE', width: 375, height: 667 },
];

const BROWSER_DEVICE_SCALE_OPTIONS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];

interface BrowserToolbarTooltipPosition {
  left: number;
  top: number;
  placement: 'top' | 'bottom';
}

export interface BrowserAnnotationResult {
  status: BrowserAnnotationStatus;
  comment?: string;
  pageUrl?: string;
  pageTitle?: string;
  element?: BrowserAnnotationElementInfo;
  rect?: BrowserAnnotationRect;
  viewport?: BrowserAnnotationScreenshotInfo;
}

export function normalizeBrowserAnnotationRect(
  rect: BrowserAnnotationRect,
  viewport: BrowserAnnotationScreenshotInfo | undefined,
  screenshot: BrowserAnnotationScreenshotInfo,
): BrowserAnnotationMarkInfo {
  const screenshotWidth = screenshot.width > 0 ? screenshot.width : 1;
  const screenshotHeight = screenshot.height > 0 ? screenshot.height : 1;
  const viewportWidth = viewport?.width && viewport.width > 0 ? viewport.width : screenshotWidth;
  const viewportHeight =
    viewport?.height && viewport.height > 0 ? viewport.height : screenshotHeight;
  const scaleX = screenshotWidth / viewportWidth;
  const scaleY = screenshotHeight / viewportHeight;
  const x = Math.max(0, Math.min(screenshotWidth, Math.round(rect.x * scaleX)));
  const y = Math.max(0, Math.min(screenshotHeight, Math.round(rect.y * scaleY)));
  const maxWidth = Math.max(0, screenshotWidth - x);
  const maxHeight = Math.max(0, screenshotHeight - y);

  return {
    shape: BrowserAnnotationShape.Rectangle,
    color: BrowserAnnotationColor.Blue,
    x,
    y,
    width: Math.max(0, Math.min(maxWidth, Math.round(rect.width * scaleX))),
    height: Math.max(0, Math.min(maxHeight, Math.round(rect.height * scaleY))),
  };
}

function normalizeBrowserUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^(https?|file):\/\//i.test(trimmed)) return trimmed;
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|::1)(:\d+)?(\/.*)?$/i.test(trimmed)) {
    return `http://${trimmed}`;
  }
  if (/^[\w.-]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
}

function normalizeBrowserPreviewUrlForMatch(value: string): string {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.toString();
  } catch {
    return value;
  }
}

function isSameBrowserPreviewUrl(value: string, previewUrl: string): boolean {
  if (!value || !previewUrl) return false;
  return normalizeBrowserPreviewUrlForMatch(value) === normalizeBrowserPreviewUrlForMatch(previewUrl);
}

function clampBrowserZoomFactor(value: number): number {
  return Math.max(BrowserZoom.Min, Math.min(BrowserZoom.Max, Number(value.toFixed(2))));
}

function clampBrowserDeviceSize(value: number): number {
  if (!Number.isFinite(value)) return BrowserDeviceViewport.MinSize;
  return Math.max(
    BrowserDeviceViewport.MinSize,
    Math.min(BrowserDeviceViewport.MaxSize, Math.round(value)),
  );
}

function clampBrowserDeviceScale(value: number): number {
  if (!Number.isFinite(value)) return BrowserDeviceScale.Default;
  return Math.max(
    BrowserDeviceScale.Min,
    Math.min(BrowserDeviceScale.Max, Number(value.toFixed(2))),
  );
}

function getBrowserDevicePresetLabel(preset: BrowserDevicePreset): string {
  return preset.labelKey ? t(preset.labelKey) : (preset.label ?? preset.id);
}

function isLocalServiceHostname(hostname: string): boolean {
  const value = hostname.toLowerCase();
  return (
    value === 'localhost' ||
    value === '127.0.0.1' ||
    value === '0.0.0.0' ||
    value === '[::1]' ||
    value === '::1'
  );
}

function parseLocalServiceUrl(
  rawUrl: string | undefined,
  title?: string,
  projectDirectory?: string,
): LocalWebService | null {
  if (!rawUrl) return null;
  try {
    const parsed = new URL(rawUrl.trim());
    if (!isLocalServiceHostname(parsed.hostname) || !parsed.port) return null;
    const port = Number(parsed.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
    return {
      id: `localhost:${port}`,
      title: title || `localhost:${port}`,
      url: rawUrl.trim(),
      host: parsed.hostname,
      port,
      online: false,
      ...(projectDirectory?.trim() ? { projectDirectory: projectDirectory.trim() } : {}),
    };
  } catch {
    return null;
  }
}

function parseLocalServiceArtifact(artifact: Artifact): LocalWebService | null {
  if (artifact.type !== ArtifactTypeValue.LocalService) return null;
  return parseLocalServiceUrl(
    artifact.url || artifact.content,
    artifact.title,
    artifact.localService?.projectDirectory,
  );
}

function shouldPreferLocalService(candidate: LocalWebService, current: LocalWebService): boolean {
  const candidateHasProject = Boolean(candidate.projectDirectory?.trim());
  const currentHasProject = Boolean(current.projectDirectory?.trim());
  if (candidateHasProject !== currentHasProject) return candidateHasProject;
  const candidateCandidateCount = candidate.projectCandidates?.length ?? 0;
  const currentCandidateCount = current.projectCandidates?.length ?? 0;
  if (candidateCandidateCount !== currentCandidateCount) return candidateCandidateCount > currentCandidateCount;
  if (candidate.online !== current.online) return candidate.online;
  return false;
}

function getSessionLocalServices(artifacts: Artifact[] | undefined): LocalWebService[] {
  const byPort = new Map<number, LocalWebService>();
  for (const artifact of artifacts ?? []) {
    const service = parseLocalServiceArtifact(artifact);
    if (!service) continue;
    const existing = byPort.get(service.port);
    if (!existing || shouldPreferLocalService(service, existing)) {
      byPort.set(service.port, service);
    }
  }
  return Array.from(byPort.values());
}

function mergeLocalServices(
  sessionServices: LocalWebService[],
  discoveredServices: LocalWebService[],
): LocalWebService[] {
  const byPort = new Map<number, LocalWebService>();
  const discoveredByPort = new Map(discoveredServices.map(service => [service.port, service]));

  for (const sessionService of sessionServices) {
    const discovered = discoveredByPort.get(sessionService.port);
    const service = discovered
      ? {
          ...sessionService,
          title: discovered.title || sessionService.title,
          url: sessionService.url || discovered.url,
          host: discovered.host || sessionService.host,
          online: true,
        }
      : sessionService;
    const existing = byPort.get(service.port);
    if (!existing || shouldPreferLocalService(service, existing)) {
      byPort.set(service.port, service);
    }
  }

  for (const discoveredService of discoveredServices) {
    const existing = byPort.get(discoveredService.port);
    if (!existing || shouldPreferLocalService(discoveredService, existing)) {
      byPort.set(discoveredService.port, discoveredService);
    }
  }

  return Array.from(byPort.values()).slice(0, LocalServiceDisplay.Limit);
}

export interface BrowserAnnotationLabels {
  instruction: string;
  placeholder: string;
  send: string;
  tag: string;
  size: string;
  color: string;
  font: string;
  statusSent: BrowserAnnotationStatus;
  statusCancelled: BrowserAnnotationStatus;
}

export function buildBrowserAnnotationScript(labels: BrowserAnnotationLabels): string {
  return `
(() => {
  const labels = ${JSON.stringify(labels)};
  if (window.__lobsterAnnotationCleanup) {
    window.__lobsterAnnotationCleanup();
  }

  const overlayRoot = document.createElement('div');
  overlayRoot.setAttribute('data-lobster-annotation-ui', 'true');
  overlayRoot.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;';

  const highlight = document.createElement('div');
  highlight.style.cssText = 'position:fixed;display:none;box-sizing:border-box;border:2px solid #1683ff;background:rgba(22,131,255,0.08);box-shadow:0 0 0 1px rgba(255,255,255,0.9);pointer-events:none;';

  const tooltip = document.createElement('div');
  tooltip.style.cssText = 'position:fixed;display:none;max-width:260px;border-radius:8px;background:rgba(18,18,22,0.94);color:#fff;padding:8px 10px;font-size:12px;line-height:1.4;box-shadow:0 8px 22px rgba(0,0,0,0.28);pointer-events:none;';

  const composer = document.createElement('div');
  composer.setAttribute('data-lobster-annotation-ui', 'true');
  composer.style.cssText = 'position:fixed;display:none;min-width:300px;max-width:380px;border-radius:16px;background:rgba(22,22,24,0.96);color:#fff;padding:6px 7px;box-shadow:0 12px 32px rgba(0,0,0,0.28);pointer-events:auto;gap:6px;align-items:center;';

  const textarea = document.createElement('textarea');
  textarea.placeholder = labels.placeholder;
  textarea.rows = 1;
  textarea.style.cssText = 'min-width:0;flex:1;height:30px;max-height:84px;resize:none;border:0;outline:none;border-radius:10px;background:transparent;color:#fff;padding:5px 8px;font:13px/18px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;';

  const sendButton = document.createElement('button');
  sendButton.type = 'button';
  sendButton.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5"></path><path d="M5 12l7-7 7 7"></path></svg>';
  sendButton.title = labels.send;
  sendButton.setAttribute('aria-label', labels.send);
  sendButton.style.cssText = 'width:32px;height:32px;border:0;border-radius:999px;background:#fff;color:#111;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;transition:opacity 120ms ease, transform 120ms ease;';

  composer.append(textarea, sendButton);
  overlayRoot.append(highlight, tooltip, composer);
  document.documentElement.appendChild(overlayRoot);

  let selectedInfo = null;
  let frozen = false;
  let resolved = false;
  let resolvePromise;

  const cleanup = () => {
    if (!resolved) {
      finish({ status: labels.statusCancelled });
    }
    document.removeEventListener('mousemove', handleMouseMove, true);
    document.removeEventListener('click', handleClick, true);
    document.removeEventListener('keydown', handleKeyDown, true);
    overlayRoot.remove();
    delete window.__lobsterAnnotationCleanup;
  };

  const finish = (result) => {
    if (resolved) return;
    resolved = true;
    resolvePromise(result);
  };

  const isAnnotationUi = (target) => target?.closest?.('[data-lobster-annotation-ui="true"]');
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const cleanText = (value) => (value || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
  const formatFont = (value) => cleanText(value).split(',')[0].replace(/["']/g, '').slice(0, 42);
  const hasComment = () => textarea.value.trim().length > 0;

  const updateSendState = () => {
    const enabled = hasComment();
    sendButton.disabled = !enabled;
    sendButton.style.opacity = enabled ? '1' : '0.42';
    sendButton.style.cursor = enabled ? 'pointer' : 'not-allowed';
    sendButton.style.transform = enabled ? 'scale(1)' : 'scale(0.98)';
  };

  const readInfo = (element) => {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    const tagName = element.tagName ? element.tagName.toLowerCase() : 'element';
    const elementText = element.getAttribute('aria-label') || element.getAttribute('alt') || element.innerText || element.textContent || '';
    return {
      tagName,
      text: cleanText(elementText),
      color: style.color || '',
      fontFamily: formatFont(style.fontFamily || ''),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      rect: {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      },
    };
  };

  const renderHighlight = (info) => {
    const rect = info.rect;
    highlight.style.display = 'block';
    highlight.style.left = rect.left + 'px';
    highlight.style.top = rect.top + 'px';
    highlight.style.width = rect.width + 'px';
    highlight.style.height = rect.height + 'px';
  };

  const renderTooltip = (info) => {
    const rect = info.rect;
    tooltip.innerHTML = [
      '<div style="display:flex;gap:12px;justify-content:space-between;"><strong>' + info.tagName + '</strong><span>' + info.width + '×' + info.height + '</span></div>',
      '<div style="display:grid;grid-template-columns:auto 1fr;column-gap:10px;margin-top:4px;color:#d6d6d6;"><span>' + labels.color + '</span><strong style="color:#fff;font-weight:600;">' + (info.color || '-') + '</strong><span>' + labels.font + '</span><strong style="color:#fff;font-weight:600;">' + (info.fontFamily || '-') + '</strong></div>',
      info.text ? '<div style="margin-top:4px;color:#bbb;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + info.text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])) + '</div>' : ''
    ].join('');
    tooltip.style.display = 'block';
    tooltip.style.left = clamp(rect.left, 8, window.innerWidth - 270) + 'px';
    tooltip.style.top = clamp(rect.top - tooltip.offsetHeight - 10, 8, window.innerHeight - tooltip.offsetHeight - 8) + 'px';
  };

  const renderComposer = (info) => {
    const rect = info.rect;
    composer.style.display = 'flex';
    composer.style.left = clamp(rect.left + Math.min(100, rect.width / 2), 8, window.innerWidth - 388) + 'px';
    composer.style.top = clamp(rect.top + Math.min(32, rect.height / 2), 8, window.innerHeight - 52) + 'px';
    textarea.focus();
  };

  function handleMouseMove(event) {
    if (frozen || isAnnotationUi(event.target)) return;
    const element = event.target;
    if (!(element instanceof Element)) return;
    const info = readInfo(element);
    if (info.width <= 0 || info.height <= 0) return;
    selectedInfo = info;
    renderHighlight(info);
    renderTooltip(info);
  }

  function handleClick(event) {
    if (isAnnotationUi(event.target)) return;
    if (!selectedInfo) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    frozen = true;
    tooltip.style.display = 'none';
    renderHighlight(selectedInfo);
    renderComposer(selectedInfo);
  }

  function handleKeyDown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      finish({ status: labels.statusCancelled });
    }
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && selectedInfo) {
      event.preventDefault();
      sendButton.click();
    }
  }

  sendButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!selectedInfo) return;
    if (!hasComment()) {
      updateSendState();
      textarea.focus();
      return;
    }
    composer.style.display = 'none';
    const { rect, ...element } = selectedInfo;
    finish({
      status: labels.statusSent,
      comment: textarea.value.trim(),
      pageUrl: location.href,
      pageTitle: document.title || '',
      rect: {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      },
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio || 1,
      },
      element,
    });
  });

  textarea.addEventListener('input', updateSendState);
  updateSendState();

  document.addEventListener('mousemove', handleMouseMove, true);
  document.addEventListener('click', handleClick, true);
  document.addEventListener('keydown', handleKeyDown, true);
  window.__lobsterAnnotationCleanup = cleanup;

  return new Promise((resolve) => {
    resolvePromise = resolve;
  });
})()
`;
}

interface BrowserTabContentProps {
  address: string;
  currentUrl: string;
  sessionArtifacts?: Artifact[];
  autoRefreshFilePath?: string;
  localHtmlPreviewUrl?: string;
  onAddressChange: (value: string) => void;
  onCurrentUrlChange: (value: string) => void;
  onTitleChange?: (value: string) => void;
  onLocalServiceOpen?: (service: LocalWebService) => void;
  publishAction?: BrowserPublishAction;
  draftKey: string;
  annotationBatch?: CoworkBrowserAnnotationBatch;
  onAnnotationBatchChange: (batch: CoworkBrowserAnnotationBatch | null) => void;
  /** Draft annotations (across pages) that would survive send-time normalization. */
  annotationSendCount?: number;
  onAnnotationSend?: () => void;
}

const BrowserTabContent: React.FC<BrowserTabContentProps> = ({
  address,
  currentUrl,
  sessionArtifacts,
  autoRefreshFilePath,
  localHtmlPreviewUrl,
  onAddressChange,
  onCurrentUrlChange,
  onTitleChange,
  onLocalServiceOpen,
  publishAction,
  draftKey,
  annotationBatch,
  onAnnotationBatchChange,
  annotationSendCount = 0,
  onAnnotationSend,
}) => {
  const [isLoading, setIsLoading] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [isCapturingScreenshot, setIsCapturingScreenshot] = useState(false);
  const [screenshotStatus, setScreenshotStatus] = useState<BrowserScreenshotStatus>(
    BrowserScreenshotStatus.Idle,
  );
  const [isAnnotating, setIsAnnotating] = useState(false);
  const browserTabIdRef = useRef(crypto.randomUUID());
  const documentIdRef = useRef(crypto.randomUUID());
  const navigationVersionRef = useRef(1);
  const annotationRevisionRef = useRef(0);
  const annotationBatchRef = useRef(annotationBatch);
  const pendingCaptureRef = useRef(new Map<string, {
    resolve: (capture: CoworkBrowserAnnotation['capture']) => void;
    reject: (error: Error) => void;
    timeoutId: number;
  }>());
  const activeCaptureIdsRef = useRef(new Set<string>());
  const replacedCaptureAssetsRef = useRef(new Map<string, BrowserAnnotationScreenshotRef>());
  const [localServices, setLocalServices] = useState<LocalWebService[]>([]);
  const [isLoadingLocalServices, setIsLoadingLocalServices] = useState(false);
  const [hoveredToolbarAction, setHoveredToolbarAction] = useState<BrowserToolbarAction | null>(
    null,
  );
  const [toolbarTooltipPosition, setToolbarTooltipPosition] =
    useState<BrowserToolbarTooltipPosition | null>(null);
  const [webviewNode, setWebviewNode] = useState<BrowserWebviewElement | null>(null);
  const [isWebviewReady, setIsWebviewReady] = useState(false);
  const [isBrowserMenuOpen, setIsBrowserMenuOpen] = useState(false);
  const [browserZoomFactor, setBrowserZoomFactor] = useState<number>(BrowserZoom.Default);
  const [isDeviceToolbarVisible, setIsDeviceToolbarVisible] = useState(false);
  const [isAddressBarFocused, setIsAddressBarFocused] = useState(false);
  const [isAddressOpenExternalHovered, setIsAddressOpenExternalHovered] = useState(false);
  const [devicePresetId, setDevicePresetId] = useState<BrowserDevicePresetId>(
    BrowserDevicePresetId.Responsive,
  );
  const [deviceWidth, setDeviceWidth] = useState<number>(BrowserDeviceViewport.DefaultWidth);
  const [deviceHeight, setDeviceHeight] = useState<number>(BrowserDeviceViewport.DefaultHeight);
  const [deviceScale, setDeviceScale] = useState<number>(BrowserDeviceScale.Default);
  const annotateButtonRef = useRef<HTMLDivElement>(null);
  const openExternalButtonRef = useRef<HTMLDivElement>(null);
  const addressBarRef = useRef<HTMLDivElement>(null);
  const addressInputRef = useRef<HTMLInputElement>(null);
  const browserMenuButtonRef = useRef<HTMLButtonElement>(null);
  const browserMenuRef = useRef<HTMLDivElement>(null);
  const screenshotStatusTimeoutRef = useRef<number | undefined>(undefined);
  const autoRefreshTimeoutRef = useRef<number | undefined>(undefined);
  const lastRequestedUrlRef = useRef('');
  const lastRequestedWebviewRef = useRef<BrowserWebviewElement | null>(null);
  const webviewNodeRef = useRef<BrowserWebviewElement | null>(null);
  const sessionLocalServices = useMemo(
    () => getSessionLocalServices(sessionArtifacts),
    [sessionArtifacts],
  );

  const sendAnnotationCommand = useCallback((
    type: string,
    batch: CoworkBrowserAnnotationBatch,
    payload: Partial<BrowserAnnotationGuestEnvelope> = {},
  ) => {
    annotationRevisionRef.current += 1;
    webviewNodeRef.current?.send?.(BrowserAnnotationGuestChannel.Command, {
      protocolVersion: BrowserAnnotationProtocolVersion,
      type,
      browserTabId: batch.browserTabId,
      documentId: batch.documentId,
      navigationVersion: batch.navigationVersion,
      batchId: batch.id,
      revision: annotationRevisionRef.current,
      ...payload,
    } satisfies BrowserAnnotationGuestEnvelope);
  }, []);

  useEffect(() => {
    const removedBatch = resolveRemovedActiveBrowserAnnotationBatch(
      annotationBatchRef.current,
      annotationBatch,
      isAnnotating,
    );
    annotationBatchRef.current = annotationBatch;
    if (!removedBatch) return;

    sendAnnotationCommand(BrowserAnnotationGuestCommandType.Clear, removedBatch);
    sendAnnotationCommand(BrowserAnnotationGuestCommandType.Stop, removedBatch);
    setIsAnnotating(false);
  }, [annotationBatch, isAnnotating, sendAnnotationCommand]);

  const commitAnnotationBatch = useCallback((batch: CoworkBrowserAnnotationBatch) => {
    annotationBatchRef.current = batch;
    onAnnotationBatchChange(batch);
  }, [onAnnotationBatchChange]);

  useEffect(() => {
    if (!isAnnotating || !annotationBatch) return;
    sendAnnotationCommand(BrowserAnnotationGuestCommandType.Sync, annotationBatch, {
      annotations: annotationBatch.annotations,
    });
  }, [annotationBatch, isAnnotating, sendAnnotationCommand]);

  const captureBrowserAnnotation = useCallback(async (
    batch: CoworkBrowserAnnotationBatch,
    annotation: CoworkBrowserAnnotation,
  ) => {
    if (activeCaptureIdsRef.current.has(annotation.id)) return;
    activeCaptureIdsRef.current.add(annotation.id);
    const requestId = annotation.screenshot.status === BrowserAnnotationScreenshotStatus.Capturing
      ? annotation.screenshot.requestId
      : crypto.randomUUID();
    try {
      const capture = await new Promise<CoworkBrowserAnnotation['capture']>((resolve, reject) => {
        const timeoutId = window.setTimeout(() => {
          pendingCaptureRef.current.delete(requestId);
          reject(new Error('Browser annotation capture timed out.'));
        }, BrowserAnnotationLimit.CaptureTimeoutMs);
        pendingCaptureRef.current.set(requestId, { resolve, reject, timeoutId });
        sendAnnotationCommand(BrowserAnnotationGuestCommandType.PrepareCapture, batch, {
          requestId,
          annotationId: annotation.id,
        });
      });
      const image = await webviewNodeRef.current?.capturePage?.();
      if (!image) throw new Error('Browser screenshot capture is unavailable.');
      const imageDataUrl = image.toDataURL();
      const saved = await window.electron?.artifact?.saveBrowserAnnotationAsset({
        draftKey,
        batchId: batch.id,
        annotationId: annotation.id,
        imageDataUrl,
        viewportWidth: capture.viewportWidth,
        viewportHeight: capture.viewportHeight,
        targetRect: capture.targetRect,
        markerViewportPoint: capture.markerViewportPoint,
        compact: batch.annotations.length >= BrowserAnnotationLimit.CompactThreshold,
      });
      if (!saved?.success || !saved.asset) throw new Error(saved?.error || 'Screenshot save failed.');
      // Keep an uncropped batch-level page screenshot alongside the annotation
      // crop; the restore view re-frames each annotation region on it.
      const pageSaved = await window.electron?.artifact?.saveBrowserAnnotationAsset({
        draftKey,
        batchId: batch.id,
        annotationId: BrowserAnnotationPageScreenshotAnnotationId,
        imageDataUrl,
        viewportWidth: capture.viewportWidth,
        viewportHeight: capture.viewportHeight,
      });
      const current = annotationBatchRef.current;
      if (!current || current.id !== batch.id) return;
      const previousPageAsset = current.pageScreenshot?.asset;
      const nextPageScreenshot = pageSaved?.success && pageSaved.asset
        ? {
            asset: pageSaved.asset,
            viewportWidth: capture.viewportWidth,
            viewportHeight: capture.viewportHeight,
            scrollX: capture.scrollX,
            scrollY: capture.scrollY,
            capturedAt: Date.now(),
          }
        : current.pageScreenshot;
      const next = {
        ...current,
        updatedAt: Date.now(),
        pageScreenshot: nextPageScreenshot,
        annotations: current.annotations.map(item => item.id === annotation.id
          ? {
              ...item,
              capture,
              screenshot: { status: BrowserAnnotationScreenshotStatus.Ready, asset: saved.asset! },
              updatedAt: Date.now(),
            }
          : item),
      };
      commitAnnotationBatch(next);
      if (
        pageSaved?.success && pageSaved.asset
        && previousPageAsset
        && previousPageAsset.assetId !== pageSaved.asset.assetId
      ) {
        void window.electron?.artifact?.deleteBrowserAnnotationAsset({
          draftKey,
          batchId: batch.id,
          annotationId: BrowserAnnotationPageScreenshotAnnotationId,
          assetId: previousPageAsset.assetId,
        });
      }
      sendAnnotationCommand(BrowserAnnotationGuestCommandType.Sync, next, {
        annotations: next.annotations,
      });
      const replacedAsset = replacedCaptureAssetsRef.current.get(annotation.id);
      replacedCaptureAssetsRef.current.delete(annotation.id);
      if (replacedAsset && replacedAsset.assetId !== saved.asset.assetId) {
        void window.electron?.artifact?.deleteBrowserAnnotationAsset({
          draftKey,
          batchId: batch.id,
          annotationId: annotation.id,
          assetId: replacedAsset.assetId,
        });
      }
    } catch (error) {
      const current = annotationBatchRef.current;
      if (current?.id === batch.id) {
        const next: CoworkBrowserAnnotationBatch = {
          ...current,
          updatedAt: Date.now(),
          annotations: current.annotations.map(item => item.id === annotation.id
            ? {
                ...item,
                screenshot: {
                  status: BrowserAnnotationScreenshotStatus.Failed,
                  reason: error instanceof Error && error.message.includes('timed out')
                    ? 'timeout'
                    : 'capture-failed',
                  failedAt: Date.now(),
                },
                updatedAt: Date.now(),
              }
            : item),
        };
        commitAnnotationBatch(next);
      }
      const replacedAsset = replacedCaptureAssetsRef.current.get(annotation.id);
      if (replacedAsset) {
        replacedCaptureAssetsRef.current.delete(annotation.id);
        void window.electron?.artifact?.deleteBrowserAnnotationAsset({
          draftKey,
          batchId: batch.id,
          annotationId: annotation.id,
          assetId: replacedAsset.assetId,
        });
      }
    } finally {
      activeCaptureIdsRef.current.delete(annotation.id);
      sendAnnotationCommand(BrowserAnnotationGuestCommandType.ResumeAfterCapture, batch, {
        requestId,
        annotationId: annotation.id,
      });
    }
  }, [commitAnnotationBatch, draftKey, sendAnnotationCommand]);

  const handleBrowserAnnotationIpc = useCallback((event: Event) => {
    const detail = event as Event & { channel?: string; args?: unknown[] };
    if (detail.channel !== BrowserAnnotationGuestChannel.Event) return;
    const message = detail.args?.[0] as BrowserAnnotationGuestEnvelope | undefined;
    const batch = annotationBatchRef.current;
    if (
      !message
      || !batch
      || message.protocolVersion !== BrowserAnnotationProtocolVersion
      || message.browserTabId !== batch.browserTabId
      || message.documentId !== batch.documentId
      || message.navigationVersion !== batch.navigationVersion
      || message.batchId !== batch.id
    ) return;
    if (message.type === BrowserAnnotationGuestEventType.CloseRequested) {
      setIsAnnotating(false);
      sendAnnotationCommand(BrowserAnnotationGuestCommandType.Stop, batch);
      return;
    }
    if (message.type === BrowserAnnotationGuestEventType.CaptureReady && message.requestId && message.capture) {
      const pending = pendingCaptureRef.current.get(message.requestId);
      if (!pending) return;
      window.clearTimeout(pending.timeoutId);
      pendingCaptureRef.current.delete(message.requestId);
      pending.resolve(message.capture);
      return;
    }
    if (message.type !== BrowserAnnotationGuestEventType.Changed || !message.annotations) return;
    for (const incoming of message.annotations) {
      if (incoming.screenshot.status !== BrowserAnnotationScreenshotStatus.Capturing) continue;
      const previous = batch.annotations.find(annotation => annotation.id === incoming.id);
      if (previous?.screenshot.status === BrowserAnnotationScreenshotStatus.Ready) {
        replacedCaptureAssetsRef.current.set(incoming.id, previous.screenshot.asset);
      }
    }
    for (const removed of batch.annotations.filter(
      annotation => !message.annotations?.some(item => item.id === annotation.id),
    )) {
      if (removed.screenshot.status === BrowserAnnotationScreenshotStatus.Ready) {
        void window.electron?.artifact?.deleteBrowserAnnotationAsset({
          draftKey,
          batchId: batch.id,
          annotationId: removed.id,
          assetId: removed.screenshot.asset.assetId,
        });
      }
      const replacedAsset = replacedCaptureAssetsRef.current.get(removed.id);
      if (replacedAsset) {
        replacedCaptureAssetsRef.current.delete(removed.id);
        void window.electron?.artifact?.deleteBrowserAnnotationAsset({
          draftKey,
          batchId: batch.id,
          annotationId: removed.id,
          assetId: replacedAsset.assetId,
        });
      }
    }
    const next: CoworkBrowserAnnotationBatch = {
      ...batch,
      annotations: message.annotations.slice(0, BrowserAnnotationLimit.MaxAnnotations),
      pageUrl: currentUrl || batch.pageUrl,
      pageTitle: message.annotations[0]?.anchor.pageTitle || batch.pageTitle,
      updatedAt: Date.now(),
    };
    commitAnnotationBatch(next);
    for (const annotation of next.annotations) {
      if (annotation.screenshot.status === BrowserAnnotationScreenshotStatus.Capturing) {
        void captureBrowserAnnotation(next, annotation);
      }
    }
  }, [captureBrowserAnnotation, commitAnnotationBatch, currentUrl, draftKey, sendAnnotationCommand]);

  const hideAddressOpenExternal = useCallback(() => {
    setIsAddressBarFocused(false);
    setIsAddressOpenExternalHovered(false);
    setHoveredToolbarAction(action =>
      action === BrowserToolbarAction.OpenExternal ? null : action,
    );
  }, []);

  useEffect(
    () => () => {
      if (screenshotStatusTimeoutRef.current !== undefined) {
        window.clearTimeout(screenshotStatusTimeoutRef.current);
      }
      if (autoRefreshTimeoutRef.current !== undefined) {
        window.clearTimeout(autoRefreshTimeoutRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (!isAddressBarFocused && !isAddressOpenExternalHovered) return undefined;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && addressBarRef.current?.contains(target)) return;
      hideAddressOpenExternal();
    };

    const handleFocusIn = (event: FocusEvent) => {
      const target = event.target as Node | null;
      if (target && addressBarRef.current?.contains(target)) return;
      hideAddressOpenExternal();
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('focusin', handleFocusIn, true);
    window.addEventListener('blur', hideAddressOpenExternal);

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('focusin', handleFocusIn, true);
      window.removeEventListener('blur', hideAddressOpenExternal);
    };
  }, [hideAddressOpenExternal, isAddressBarFocused, isAddressOpenExternalHovered]);

  const handleWebviewRef = useCallback((node: BrowserWebviewElement | null) => {
    if (webviewNodeRef.current === node) return;
    webviewNodeRef.current = node;
    lastRequestedUrlRef.current = '';
    lastRequestedWebviewRef.current = null;
    setIsWebviewReady(false);
    setWebviewNode(node);
  }, []);

  const loadLocalServices = useCallback(async () => {
    if (!window.electron?.artifact?.listLocalWebServices) return;
    setIsLoadingLocalServices(true);
    try {
      const services = await window.electron.artifact.listLocalWebServices({
        preferredPorts: sessionLocalServices.map(service => service.port),
      });
      setLocalServices(mergeLocalServices(sessionLocalServices, services));
    } catch {
      setLocalServices(sessionLocalServices.slice(0, LocalServiceDisplay.Limit));
    } finally {
      setIsLoadingLocalServices(false);
    }
  }, [sessionLocalServices]);

  useEffect(() => {
    if (currentUrl) return;
    void loadLocalServices();
  }, [currentUrl, loadLocalServices]);

  useEffect(() => {
    if (!isBrowserMenuOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        browserMenuRef.current?.contains(target) ||
        browserMenuButtonRef.current?.contains(target)
      ) {
        return;
      }
      setIsBrowserMenuOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsBrowserMenuOpen(false);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isBrowserMenuOpen]);

  const getBrowserAddressForUrl = useCallback(
    (nextUrl: string): string => {
      if (
        autoRefreshFilePath &&
        localHtmlPreviewUrl &&
        isSameBrowserPreviewUrl(nextUrl, localHtmlPreviewUrl)
      ) {
        return autoRefreshFilePath;
      }
      return nextUrl;
    },
    [autoRefreshFilePath, localHtmlPreviewUrl],
  );

  const syncBrowserTitle = useCallback(
    (node: BrowserWebviewElement | null) => {
      if (!onTitleChange || !node) return;
      const pageUrl = node.getURL?.() || currentUrl;
      const addressSnapshot = address;
      const emitTitle = (value: string | undefined) => {
        onTitleChange(normalizeBrowserPageTitle(value, pageUrl, addressSnapshot));
      };

      if (!node.executeJavaScript) {
        emitTitle(node.getTitle?.());
        return;
      }

      void node
        .executeJavaScript('document.title || ""')
        .then(result => {
          if (pageUrl && node.getURL?.() && node.getURL?.() !== pageUrl) return;
          emitTitle(typeof result === 'string' ? result : '');
        })
        .catch(() => {
          emitTitle(node.getTitle?.());
        });
    },
    [address, currentUrl, onTitleChange],
  );

  const syncNavigationState = useCallback(
    (node: BrowserWebviewElement | null) => {
      if (!node) return;
      setCanGoBack(node.canGoBack?.() ?? false);
      setCanGoForward(node.canGoForward?.() ?? false);
      syncBrowserTitle(node);
      const nextUrl = node.getURL?.();
      if (nextUrl && nextUrl !== BrowserPageUrl.Blank) {
        onCurrentUrlChange(nextUrl);
        onAddressChange(getBrowserAddressForUrl(nextUrl));
      }
    },
    [getBrowserAddressForUrl, onAddressChange, onCurrentUrlChange, syncBrowserTitle],
  );

  const getToolbarActionElement = useCallback(
    (action: BrowserToolbarAction): HTMLDivElement | null => {
      switch (action) {
        case BrowserToolbarAction.Annotate:
          return annotateButtonRef.current;
        case BrowserToolbarAction.OpenExternal:
          return openExternalButtonRef.current;
        default:
          return null;
      }
    },
    [],
  );

  useLayoutEffect(() => {
    if (!hoveredToolbarAction) {
      setToolbarTooltipPosition(null);
      return;
    }

    const updatePosition = () => {
      const element = getToolbarActionElement(hoveredToolbarAction);
      if (!element) {
        setToolbarTooltipPosition(null);
        return;
      }
      const rect = element.getBoundingClientRect();
      const placement = rect.top >= 34 ? 'top' : 'bottom';
      const top = placement === 'top' ? rect.top - 8 : rect.bottom + 8;
      const left = Math.max(8, Math.min(window.innerWidth - 8, rect.left + rect.width / 2));
      setToolbarTooltipPosition({ left, top, placement });
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [getToolbarActionElement, hoveredToolbarAction]);

  useLayoutEffect(() => {
    if (!webviewNode) return;

    const handleStartLoading = () => setIsLoading(true);
    const handleStopLoading = () => {
      setIsLoading(false);
      syncNavigationState(webviewNode);
    };
    const handleNavigate = (event: Event) => {
      const nextUrl = (event as Event & { url?: string }).url;
      if (nextUrl && nextUrl !== BrowserPageUrl.Blank) {
        onCurrentUrlChange(nextUrl);
        onAddressChange(getBrowserAddressForUrl(nextUrl));
      }
      syncNavigationState(webviewNode);
    };
    const handleDocumentNavigate = (event: Event) => {
      const activeBatch = annotationBatchRef.current;
      if (isAnnotating && activeBatch) {
        sendAnnotationCommand(BrowserAnnotationGuestCommandType.Stop, activeBatch);
      }
      setIsAnnotating(false);
      documentIdRef.current = crypto.randomUUID();
      navigationVersionRef.current += 1;
      handleNavigate(event);
    };
    const handleTitleUpdated = () => {
      syncBrowserTitle(webviewNode);
    };
    const handleFailLoad = (event: Event) => {
      const detail = event as Event & { errorCode?: number };
      setIsLoading(false);
      if (detail.errorCode === -3) return;
      syncNavigationState(webviewNode);
    };
    const handleDomReady = () => {
      setIsWebviewReady(true);
      webviewNode.setZoomFactor?.(browserZoomFactor);
      handleStopLoading();
    };

    webviewNode.addEventListener('did-start-loading', handleStartLoading);
    webviewNode.addEventListener('did-stop-loading', handleStopLoading);
    webviewNode.addEventListener('did-fail-load', handleFailLoad);
    webviewNode.addEventListener('did-navigate', handleDocumentNavigate);
    webviewNode.addEventListener('did-navigate-in-page', handleNavigate);
    webviewNode.addEventListener('page-title-updated', handleTitleUpdated);
    webviewNode.addEventListener('dom-ready', handleDomReady);
    webviewNode.addEventListener('ipc-message', handleBrowserAnnotationIpc);
    return () => {
      webviewNode.removeEventListener('did-start-loading', handleStartLoading);
      webviewNode.removeEventListener('did-stop-loading', handleStopLoading);
      webviewNode.removeEventListener('did-fail-load', handleFailLoad);
      webviewNode.removeEventListener('did-navigate', handleDocumentNavigate);
      webviewNode.removeEventListener('did-navigate-in-page', handleNavigate);
      webviewNode.removeEventListener('page-title-updated', handleTitleUpdated);
      webviewNode.removeEventListener('dom-ready', handleDomReady);
      webviewNode.removeEventListener('ipc-message', handleBrowserAnnotationIpc);
    };
  }, [
    browserZoomFactor,
    getBrowserAddressForUrl,
    handleBrowserAnnotationIpc,
    isAnnotating,
    onAddressChange,
    onCurrentUrlChange,
    sendAnnotationCommand,
    syncBrowserTitle,
    syncNavigationState,
    webviewNode,
  ]);

  useEffect(() => {
    if (!isWebviewReady || !webviewNode?.setZoomFactor) return;
    webviewNode.setZoomFactor(browserZoomFactor);
  }, [browserZoomFactor, isWebviewReady, webviewNode]);

  useEffect(() => {
    if (!autoRefreshFilePath || !currentUrl) return;

    let cleanup: (() => void) | undefined;
    const watchedPath = autoRefreshFilePath;
    window.electron?.artifact?.watchFile(watchedPath);
    cleanup = window.electron?.artifact?.onFileChanged(({ filePath: changedPath }) => {
      if (changedPath !== watchedPath) return;
      if (autoRefreshTimeoutRef.current !== undefined) {
        window.clearTimeout(autoRefreshTimeoutRef.current);
      }
      autoRefreshTimeoutRef.current = window.setTimeout(() => {
        autoRefreshTimeoutRef.current = undefined;
        webviewNodeRef.current?.reload?.();
      }, 120);
    });

    return () => {
      if (autoRefreshTimeoutRef.current !== undefined) {
        window.clearTimeout(autoRefreshTimeoutRef.current);
        autoRefreshTimeoutRef.current = undefined;
      }
      cleanup?.();
      window.electron?.artifact?.unwatchFile(watchedPath);
    };
  }, [autoRefreshFilePath, currentUrl]);

  useEffect(() => {
    if (!currentUrl || !isWebviewReady || !webviewNode?.loadURL) return;

    const loadedUrl = webviewNode.getURL?.();
    const isSamePendingRequest =
      lastRequestedWebviewRef.current === webviewNode && lastRequestedUrlRef.current === currentUrl;
    if (loadedUrl === currentUrl || isSamePendingRequest) return;

    lastRequestedUrlRef.current = currentUrl;
    lastRequestedWebviewRef.current = webviewNode;
    setIsLoading(true);
    let loadPromise: Promise<void>;
    try {
      loadPromise = webviewNode.loadURL(currentUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('dom-ready') || message.includes('attached to the DOM')) {
        setIsWebviewReady(false);
        return;
      }
      lastRequestedUrlRef.current = '';
      lastRequestedWebviewRef.current = null;
      setIsLoading(false);
      return;
    }
    loadPromise.catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('ERR_ABORTED') || message.includes('(-3)')) return;
      lastRequestedUrlRef.current = '';
      lastRequestedWebviewRef.current = null;
      setIsLoading(false);
    });
  }, [currentUrl, isWebviewReady, webviewNode]);

  const handleNavigate = useCallback(() => {
    const trimmedAddress = address.trim();
    if (
      autoRefreshFilePath &&
      localHtmlPreviewUrl &&
      trimmedAddress === autoRefreshFilePath
    ) {
      onTitleChange?.('');
      onCurrentUrlChange(localHtmlPreviewUrl);
      onAddressChange(autoRefreshFilePath);
      webviewNodeRef.current?.reload?.();
      return;
    }

    const nextUrl = normalizeBrowserUrl(address);
    if (!nextUrl) return;
    onTitleChange?.('');
    onCurrentUrlChange(nextUrl);
    onAddressChange(nextUrl);
  }, [
    address,
    autoRefreshFilePath,
    localHtmlPreviewUrl,
    onAddressChange,
    onCurrentUrlChange,
    onTitleChange,
  ]);

  const handleOpenLocalService = useCallback(
    (service: LocalWebService) => {
      onLocalServiceOpen?.(service);
      onTitleChange?.('');
      onCurrentUrlChange(service.url);
      onAddressChange(service.url);
    },
    [onAddressChange, onCurrentUrlChange, onLocalServiceOpen, onTitleChange],
  );

  const handleAddressKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') {
        handleNavigate();
      }
    },
    [handleNavigate],
  );

  const handleAddressFocus = useCallback((event: React.FocusEvent<HTMLInputElement>) => {
    setIsAddressBarFocused(true);
    event.currentTarget.select();
  }, []);

  const handleAddressBarFocusCapture = useCallback(() => {
    setIsAddressBarFocused(true);
  }, []);

  const handleAddressBarBlurCapture = useCallback(() => {
    window.requestAnimationFrame(() => {
      const activeElement = document.activeElement;
      if (activeElement && addressBarRef.current?.contains(activeElement)) return;
      hideAddressOpenExternal();
    });
  }, [hideAddressOpenExternal]);

  const handleAddressBarMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    addressInputRef.current?.focus();
    addressInputRef.current?.select();
  }, []);

  const handleAddressOpenExternalMouseEnter = useCallback(() => {
    if (!currentUrl) return;
    setIsAddressOpenExternalHovered(true);
    setHoveredToolbarAction(BrowserToolbarAction.OpenExternal);
  }, [currentUrl]);

  const handleAddressOpenExternalMouseLeave = useCallback(() => {
    setIsAddressOpenExternalHovered(false);
    setHoveredToolbarAction(null);
  }, []);

  const handleOpenExternal = useCallback(() => {
    if (!currentUrl) return;
    window.electron?.shell?.openExternal(currentUrl);
  }, [currentUrl]);

  const handleToggleDeviceToolbar = useCallback(() => {
    setIsDeviceToolbarVisible(value => {
      const nextVisible = !value;
      return nextVisible;
    });
    setIsBrowserMenuOpen(false);
  }, []);

  const handleDevicePresetChange = useCallback((value: string) => {
    const preset = BROWSER_DEVICE_PRESETS.find(item => item.id === value);
    if (!preset) return;
    setDevicePresetId(preset.id);
    setDeviceWidth(preset.width);
    setDeviceHeight(preset.height);
  }, []);

  const handleDeviceWidthChange = useCallback((value: string) => {
    setDevicePresetId(BrowserDevicePresetId.Responsive);
    setDeviceWidth(clampBrowserDeviceSize(Number(value)));
  }, []);

  const handleDeviceHeightChange = useCallback((value: string) => {
    setDevicePresetId(BrowserDevicePresetId.Responsive);
    setDeviceHeight(clampBrowserDeviceSize(Number(value)));
  }, []);

  const handleRotateDevice = useCallback(() => {
    setDevicePresetId(BrowserDevicePresetId.Responsive);
    setDeviceWidth(deviceHeight);
    setDeviceHeight(deviceWidth);
  }, [deviceHeight, deviceWidth]);

  const handleDeviceScaleChange = useCallback((value: string) => {
    setDeviceScale(clampBrowserDeviceScale(Number(value)));
  }, []);

  const applyBrowserZoom = useCallback(
    (nextFactor: number) => {
      const clampedFactor = clampBrowserZoomFactor(nextFactor);
      setBrowserZoomFactor(clampedFactor);
      webviewNode?.setZoomFactor?.(clampedFactor);
    },
    [webviewNode],
  );

  const handleZoomOut = useCallback(() => {
    applyBrowserZoom(browserZoomFactor - BrowserZoom.Step);
  }, [applyBrowserZoom, browserZoomFactor]);

  const handleZoomIn = useCallback(() => {
    applyBrowserZoom(browserZoomFactor + BrowserZoom.Step);
  }, [applyBrowserZoom, browserZoomFactor]);

  const handleResetZoom = useCallback(() => {
    applyBrowserZoom(BrowserZoom.Default);
  }, [applyBrowserZoom]);

  const handleOpenBlankPage = useCallback(() => {
    setIsBrowserMenuOpen(false);
    lastRequestedUrlRef.current = '';
    lastRequestedWebviewRef.current = null;
    onAddressChange('');
    onCurrentUrlChange('');
    onTitleChange?.('');
  }, [onAddressChange, onCurrentUrlChange, onTitleChange]);

  const handleClearBrowserCookies = useCallback(async () => {
    setIsBrowserMenuOpen(false);
    try {
      const result = await window.electron?.artifact?.clearBrowserCookies?.();
      window.dispatchEvent(
        new CustomEvent('app:showToast', {
          detail: result?.success
            ? t('artifactBrowserCookiesCleared')
            : result?.error || t('artifactBrowserClearCookiesFailed'),
        }),
      );
    } catch {
      window.dispatchEvent(
        new CustomEvent('app:showToast', {
          detail: t('artifactBrowserClearCookiesFailed'),
        }),
      );
    }
  }, []);

  const handleClearBrowserCache = useCallback(async () => {
    setIsBrowserMenuOpen(false);
    try {
      const result = await window.electron?.artifact?.clearBrowserCache?.();
      window.dispatchEvent(
        new CustomEvent('app:showToast', {
          detail: result?.success
            ? t('artifactBrowserCacheCleared')
            : result?.error || t('artifactBrowserClearCacheFailed'),
        }),
      );
    } catch {
      window.dispatchEvent(
        new CustomEvent('app:showToast', {
          detail: t('artifactBrowserClearCacheFailed'),
        }),
      );
    }
  }, []);

  const setTemporaryScreenshotStatus = useCallback((status: BrowserScreenshotStatus) => {
    setScreenshotStatus(status);
    if (screenshotStatusTimeoutRef.current !== undefined) {
      window.clearTimeout(screenshotStatusTimeoutRef.current);
    }
    screenshotStatusTimeoutRef.current = window.setTimeout(() => {
      setScreenshotStatus(BrowserScreenshotStatus.Idle);
      screenshotStatusTimeoutRef.current = undefined;
    }, 1600);
  }, []);

  const handleCaptureScreenshot = useCallback(async () => {
    if (!webviewNode?.capturePage || !currentUrl || isCapturingScreenshot) return;
    setIsCapturingScreenshot(true);
    try {
      const image = await webviewNode.capturePage();
      const result = await window.electron?.clipboard?.writeImageFromDataUrl(image.toDataURL());
      if (!result?.success) {
        throw new Error(result?.error || 'Failed to write browser screenshot to clipboard');
      }
      setTemporaryScreenshotStatus(BrowserScreenshotStatus.Copied);
      window.dispatchEvent(
        new CustomEvent('app:showToast', {
          detail: t('artifactBrowserScreenshotCopied'),
        }),
      );
    } catch {
      setTemporaryScreenshotStatus(BrowserScreenshotStatus.Error);
      window.dispatchEvent(
        new CustomEvent('app:showToast', {
          detail: t('artifactBrowserScreenshotFailed'),
        }),
      );
    } finally {
      setIsCapturingScreenshot(false);
    }
  }, [currentUrl, isCapturingScreenshot, setTemporaryScreenshotStatus, webviewNode]);

  const handleCaptureScreenshotFromMenu = useCallback(() => {
    setIsBrowserMenuOpen(false);
    void handleCaptureScreenshot();
  }, [handleCaptureScreenshot]);

  const handleToggleAnnotation = useCallback(async () => {
    if (!webviewNode?.send || !webviewNode.capturePage || !currentUrl) return;
    if (isAnnotating) {
      const batch = annotationBatchRef.current;
      if (batch) sendAnnotationCommand(BrowserAnnotationGuestCommandType.Stop, batch);
      setIsAnnotating(false);
      return;
    }
    const now = Date.now();
    const currentNormalizedUrl = normalizeBrowserPreviewUrlForMatch(currentUrl);
    const existing = annotationBatchRef.current?.pageUrl
      && normalizeBrowserPreviewUrlForMatch(annotationBatchRef.current.pageUrl) === currentNormalizedUrl
      ? annotationBatchRef.current
      : undefined;
    const batch: CoworkBrowserAnnotationBatch = existing || {
      version: 1,
      id: crypto.randomUUID(),
      browserTabId: browserTabIdRef.current,
      documentId: documentIdRef.current,
      navigationVersion: navigationVersionRef.current,
      pageUrl: currentUrl,
      pageTitle: webviewNode.getTitle?.() || '',
      annotations: [],
      createdAt: now,
      updatedAt: now,
    };
    commitAnnotationBatch(batch);
    setIsAnnotating(true);
    sendAnnotationCommand(BrowserAnnotationGuestCommandType.Start, batch, {
      annotations: batch.annotations,
      labels: {
        placeholder: t('artifactBrowserAnnotationPlaceholder'),
        save: t('artifactBrowserAnnotationSave'),
        cancel: t('cancel'),
        remove: t('delete'),
        settings: t('artifactBrowserAnnotationSettings'),
        text: t('artifactBrowserAnnotationText'),
        textColor: t('artifactBrowserAnnotationTextColor'),
        background: t('artifactBrowserAnnotationBackground'),
        opacity: t('artifactBrowserAnnotationOpacity'),
        font: t('artifactBrowserAnnotationFont'),
        fontSize: t('artifactBrowserAnnotationFontSize'),
        fontWeight: t('artifactBrowserAnnotationFontWeight'),
        borderRadius: t('artifactBrowserAnnotationBorderRadius'),
        borderColor: t('artifactBrowserAnnotationBorderColor'),
        borderWidth: t('artifactBrowserAnnotationBorderWidth'),
        width: t('artifactBrowserAnnotationWidth'),
        height: t('artifactBrowserAnnotationHeight'),
        padding: t('artifactBrowserAnnotationPadding'),
        margin: t('artifactBrowserAnnotationMargin'),
        flexDirection: t('artifactBrowserAnnotationFlexDirection'),
        justifyContent: t('artifactBrowserAnnotationJustifyContent'),
        alignItems: t('artifactBrowserAnnotationAlignItems'),
        gap: t('artifactBrowserAnnotationGap'),
        top: t('artifactBrowserAnnotationTop'),
        right: t('artifactBrowserAnnotationRight'),
        bottom: t('artifactBrowserAnnotationBottom'),
        left: t('artifactBrowserAnnotationLeft'),
        horizontal: t('artifactBrowserAnnotationHorizontal'),
        vertical: t('artifactBrowserAnnotationVertical'),
        horizontalReverse: t('artifactBrowserAnnotationHorizontalReverse'),
        verticalReverse: t('artifactBrowserAnnotationVerticalReverse'),
        start: t('artifactBrowserAnnotationStart'),
        center: t('artifactBrowserAnnotationCenter'),
        end: t('artifactBrowserAnnotationEnd'),
        spaceBetween: t('artifactBrowserAnnotationSpaceBetween'),
        spaceAround: t('artifactBrowserAnnotationSpaceAround'),
        spaceEvenly: t('artifactBrowserAnnotationSpaceEvenly'),
        stretch: t('artifactBrowserAnnotationStretch'),
        complexText: t('artifactBrowserAnnotationComplexText'),
      },
    });
  }, [commitAnnotationBatch, currentUrl, isAnnotating, sendAnnotationCommand, webviewNode]);

  const screenshotButtonTitle =
    screenshotStatus === BrowserScreenshotStatus.Copied
      ? t('artifactBrowserScreenshotCopied')
      : screenshotStatus === BrowserScreenshotStatus.Error
        ? t('artifactBrowserScreenshotFailed')
        : t('artifactBrowserScreenshot');

  const hoveredToolbarLabel =
    hoveredToolbarAction === BrowserToolbarAction.Annotate
      ? t(isAnnotating ? 'artifactBrowserAnnotating' : 'artifactBrowserAnnotate')
      : hoveredToolbarAction === BrowserToolbarAction.OpenExternal
        ? t('artifactBrowserOpenExternal')
        : '';
  const showAddressOpenExternal =
    Boolean(currentUrl) && (isAddressBarFocused || isAddressOpenExternalHovered);
  return (
    <div className="relative flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border px-3">
        <button
          type="button"
          onClick={() => {
            webviewNode?.goBack?.();
          }}
          disabled={!canGoBack}
          className="inline-flex h-7 w-7 items-center justify-center rounded text-secondary transition-colors hover:bg-surface hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45 disabled:cursor-not-allowed disabled:opacity-35"
          title={t('artifactBrowserBack')}
        >
          <ChevronLeftIcon />
        </button>
        <button
          type="button"
          onClick={() => {
            webviewNode?.goForward?.();
          }}
          disabled={!canGoForward}
          className="inline-flex h-7 w-7 items-center justify-center rounded text-secondary transition-colors hover:bg-surface hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45 disabled:cursor-not-allowed disabled:opacity-35"
          title={t('artifactBrowserForward')}
        >
          <ChevronRightBrowserIcon />
        </button>
        <button
          type="button"
          onClick={() => {
            if (isLoading) {
              webviewNode?.stop?.();
            } else {
              webviewNode?.reload?.();
            }
          }}
          disabled={!currentUrl}
          className="inline-flex h-7 w-7 items-center justify-center rounded text-secondary transition-colors hover:bg-surface hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45 disabled:cursor-not-allowed disabled:opacity-35"
          title={isLoading ? t('artifactBrowserStop') : t('artifactBrowserReload')}
        >
          {isLoading ? <StopIcon /> : <RefreshIcon />}
        </button>
        <div
          ref={addressBarRef}
          className="relative flex h-7 min-w-0 flex-1 items-center rounded-md border border-transparent bg-transparent px-2 pr-10 transition-colors hover:bg-surface focus-within:border-border focus-within:bg-surface"
          onFocusCapture={handleAddressBarFocusCapture}
          onBlurCapture={handleAddressBarBlurCapture}
          onMouseDown={handleAddressBarMouseDown}
        >
          <input
            ref={addressInputRef}
            type="text"
            value={address}
            onChange={event => onAddressChange(event.target.value)}
            onKeyDown={handleAddressKeyDown}
            onFocus={handleAddressFocus}
            placeholder={t('artifactBrowserUrlPlaceholder')}
            className="h-full min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted"
          />
          <div
            ref={openExternalButtonRef}
            className={`absolute inset-y-0 right-0 flex w-8 items-center justify-center overflow-hidden rounded-r-[5px] transition-opacity duration-150 ${
              showAddressOpenExternal
                ? 'opacity-100'
                : 'opacity-0'
            }`}
            onMouseEnter={handleAddressOpenExternalMouseEnter}
            onMouseLeave={handleAddressOpenExternalMouseLeave}
          >
            <button
              type="button"
              onMouseDown={event => event.preventDefault()}
              onClick={handleOpenExternal}
              disabled={!currentUrl}
              tabIndex={showAddressOpenExternal ? 0 : -1}
              className="inline-flex h-full w-full items-center justify-center rounded-l-none rounded-r-[5px] border-l border-border bg-black/[0.035] text-secondary transition-colors hover:bg-black/[0.06] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35 dark:bg-white/[0.045] dark:hover:bg-white/[0.075]"
              aria-label={t('artifactBrowserOpenExternal')}
              title={t('artifactBrowserOpenExternal')}
            >
              <BrowserAddressOpenExternalIcon />
            </button>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {publishAction && (
            <button
              type="button"
              onClick={publishAction.onClick}
              disabled={publishAction.disabled}
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-secondary transition-colors hover:bg-surface hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45 disabled:cursor-not-allowed disabled:opacity-35"
              aria-label={publishAction.label}
              title={publishAction.label}
            >
              {publishAction.busy ? (
                <span
                  className="h-4 w-4 animate-spin rounded-full border-2 border-primary/30 border-t-primary"
                  aria-hidden="true"
                />
              ) : (
                <ShareUploadIcon />
              )}
            </button>
          )}
          <div
            ref={annotateButtonRef}
            className="flex h-7 shrink-0 items-center justify-center"
            onMouseEnter={() => setHoveredToolbarAction(BrowserToolbarAction.Annotate)}
            onMouseLeave={() => setHoveredToolbarAction(null)}
          >
            <button
              type="button"
              onClick={handleToggleAnnotation}
              disabled={!currentUrl}
              className={`inline-flex h-7 items-center justify-center rounded text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45 disabled:cursor-not-allowed disabled:opacity-35 ${
                isAnnotating
                  ? 'gap-1.5 bg-primary/10 px-2 text-primary hover:bg-primary/15'
                  : 'w-7 text-secondary hover:bg-surface hover:text-foreground'
              }`}
              aria-label={t(isAnnotating ? 'artifactBrowserAnnotating' : 'artifactBrowserAnnotate')}
              title={isAnnotating ? t('artifactBrowserAnnotating') : t('artifactBrowserAnnotate')}
            >
              <AnnotateIcon />
              {isAnnotating ? (
                <span className="whitespace-nowrap">
                  {t('artifactBrowserAnnotating')}
                  {annotationBatch?.annotations.length ? ` · ${annotationBatch.annotations.length}` : ''}
                </span>
              ) : null}
            </button>
          </div>
          {isAnnotating && annotationSendCount > 0 && onAnnotationSend ? (
            <button
              type="button"
              onClick={() => {
                onAnnotationSend();
              }}
              className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-primary pl-2.5 pr-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45"
            >
              <span className="whitespace-nowrap">{t('browserAnnotationsSend')}</span>
              <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-white/25 px-1 text-[10px] font-semibold">
                {annotationSendCount}
              </span>
            </button>
          ) : null}
          <button
            ref={browserMenuButtonRef}
            type="button"
            onClick={() => setIsBrowserMenuOpen(value => {
              const nextOpen = !value;
              return nextOpen;
            })}
            className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45 ${
              isBrowserMenuOpen
                ? 'bg-surface text-foreground'
                : 'text-secondary hover:bg-surface hover:text-foreground'
            }`}
            aria-label={t('artifactBrowserMenu')}
            title={t('artifactBrowserMenu')}
          >
            <MoreVerticalIcon />
          </button>
        </div>
      </div>
      {isBrowserMenuOpen && (
        <div
          ref={browserMenuRef}
          className="absolute right-3 top-10 z-40 w-56 rounded-lg border border-border bg-surface-raised p-2 text-sm text-foreground shadow-xl"
        >
          <button
            type="button"
            onClick={handleCaptureScreenshotFromMenu}
            disabled={!currentUrl || isCapturingScreenshot}
            className="flex h-8 w-full items-center rounded-md px-2 text-left text-xs transition-colors hover:bg-surface disabled:cursor-not-allowed disabled:opacity-35"
          >
            {screenshotButtonTitle}
          </button>
          <div className="my-1 border-t border-border" />
          <button
            type="button"
            onClick={handleOpenBlankPage}
            className="flex h-8 w-full items-center rounded-md px-2 text-left text-xs transition-colors hover:bg-surface"
          >
            {t('artifactBrowserBlankPage')}
          </button>
          <button
            type="button"
            onClick={handleToggleDeviceToolbar}
            className={`flex h-8 w-full items-center rounded-md px-2 text-left text-xs transition-colors hover:bg-surface ${
              isDeviceToolbarVisible ? 'bg-surface text-foreground' : ''
            }`}
          >
            {isDeviceToolbarVisible
              ? t('artifactBrowserHideDeviceToolbar')
              : t('artifactBrowserShowDeviceToolbar')}
          </button>
          <div className="my-1 border-t border-border" />
          <div className="flex h-9 items-center gap-2 px-2">
            <span className="min-w-0 flex-1 text-xs text-secondary">
              {t('artifactBrowserZoom')}
            </span>
            <div className="flex h-7 shrink-0 items-center overflow-hidden rounded-md border border-border bg-background">
              <button
                type="button"
                onClick={handleZoomOut}
                disabled={browserZoomFactor <= BrowserZoom.Min}
                className="inline-flex h-full w-7 items-center justify-center text-secondary transition-colors hover:bg-surface hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35"
                title={t('artifactBrowserZoomOut')}
              >
                <MinusIcon />
              </button>
              <button
                type="button"
                onClick={handleResetZoom}
                className="h-full min-w-[54px] border-x border-border px-2 text-center text-xs text-foreground transition-colors hover:bg-surface"
                title={t('artifactBrowserResetZoom')}
              >
                {Math.round(browserZoomFactor * 100)}%
              </button>
              <button
                type="button"
                onClick={handleZoomIn}
                disabled={browserZoomFactor >= BrowserZoom.Max}
                className="inline-flex h-full w-7 items-center justify-center text-secondary transition-colors hover:bg-surface hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35"
                title={t('artifactBrowserZoomIn')}
              >
                <PlusIcon />
              </button>
            </div>
          </div>
          <div className="my-1 border-t border-border" />
          <button
            type="button"
            onClick={handleClearBrowserCookies}
            className="flex h-8 w-full items-center rounded-md px-2 text-left text-xs transition-colors hover:bg-surface"
          >
            {t('artifactBrowserClearCookies')}
          </button>
          <button
            type="button"
            onClick={handleClearBrowserCache}
            className="flex h-8 w-full items-center rounded-md px-2 text-left text-xs transition-colors hover:bg-surface"
          >
            {t('artifactBrowserClearCache')}
          </button>
        </div>
      )}
      {hoveredToolbarLabel &&
        toolbarTooltipPosition &&
        createPortal(
          <div
            className="pointer-events-none fixed z-[9999] -translate-x-1/2 whitespace-nowrap rounded-md bg-foreground px-2 py-1 text-[11px] leading-none text-background shadow-sm"
            style={{
              left: toolbarTooltipPosition.left,
              top: toolbarTooltipPosition.top,
              transform:
                toolbarTooltipPosition.placement === 'top'
                  ? 'translate(-50%, -100%)'
                  : 'translate(-50%, 0)',
            }}
          >
            {hoveredToolbarLabel}
          </div>,
          document.body,
        )}
      {currentUrl ? (
        <div className="flex min-h-0 flex-1 flex-col bg-background">
          {isDeviceToolbarVisible && (
            <div className="flex h-8 shrink-0 items-center gap-2 overflow-x-auto border-b border-border bg-background px-2 text-xs text-secondary">
              <span className="shrink-0 text-foreground">{t('artifactBrowserDeviceSize')}</span>
              <select
                value={devicePresetId}
                onChange={event => handleDevicePresetChange(event.target.value)}
                className="h-7 w-[176px] rounded-md border border-border bg-surface px-2 text-xs text-foreground outline-none focus:border-primary"
                title={t('artifactBrowserDevicePreset')}
              >
                {BROWSER_DEVICE_PRESETS.map(preset => (
                  <option key={preset.id} value={preset.id}>
                    {getBrowserDevicePresetLabel(preset)}
                  </option>
                ))}
              </select>
              <input
                type="number"
                min={BrowserDeviceViewport.MinSize}
                max={BrowserDeviceViewport.MaxSize}
                value={deviceWidth}
                onChange={event => handleDeviceWidthChange(event.target.value)}
                className="h-7 w-[72px] rounded-md border border-border bg-surface px-2 text-center text-xs text-foreground outline-none focus:border-primary"
                aria-label={t('artifactBrowserDeviceWidth')}
                title={t('artifactBrowserDeviceWidth')}
              />
              <span className="text-muted">x</span>
              <input
                type="number"
                min={BrowserDeviceViewport.MinSize}
                max={BrowserDeviceViewport.MaxSize}
                value={deviceHeight}
                onChange={event => handleDeviceHeightChange(event.target.value)}
                className="h-7 w-[72px] rounded-md border border-border bg-surface px-2 text-center text-xs text-foreground outline-none focus:border-primary"
                aria-label={t('artifactBrowserDeviceHeight')}
                title={t('artifactBrowserDeviceHeight')}
              />
              <button
                type="button"
                onClick={handleRotateDevice}
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-secondary transition-colors hover:bg-surface hover:text-foreground"
                title={t('artifactBrowserDeviceRotate')}
              >
                <RotateDeviceIcon />
              </button>
              <select
                value={deviceScale}
                onChange={event => handleDeviceScaleChange(event.target.value)}
                className="h-7 w-[82px] rounded-md border border-border bg-transparent px-2 text-xs text-secondary outline-none hover:bg-surface hover:text-foreground focus:border-primary"
                title={t('artifactBrowserDeviceScale')}
              >
                {BROWSER_DEVICE_SCALE_OPTIONS.map(scale => (
                  <option key={scale} value={scale}>
                    {Math.round(scale * 100)}%
                  </option>
                ))}
              </select>
              <span className="min-w-0 flex-1" />
              <button
                type="button"
                onClick={() => setIsDeviceToolbarVisible(false)}
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-secondary transition-colors hover:bg-surface hover:text-foreground"
                title={t('artifactBrowserHideDeviceToolbar')}
              >
                <CloseIcon />
              </button>
            </div>
          )}
          <div
            className={`min-h-0 flex-1 overflow-auto ${isDeviceToolbarVisible ? 'bg-surface px-5 py-4' : 'bg-white'}`}
          >
            <div
              className={
                isDeviceToolbarVisible ? 'mx-auto overflow-hidden shadow-sm' : 'h-full w-full'
              }
              style={
                isDeviceToolbarVisible
                  ? {
                      width: deviceWidth * deviceScale,
                      height: deviceHeight * deviceScale,
                    }
                  : undefined
              }
            >
              <div
                className="h-full w-full origin-top-left bg-white"
                style={
                  isDeviceToolbarVisible
                    ? {
                        width: deviceWidth,
                        height: deviceHeight,
                        transform: `scale(${deviceScale})`,
                      }
                    : undefined
                }
              >
                {React.createElement('webview', {
                  ref: handleWebviewRef,
                  src: BrowserPageUrl.Blank,
                  partition: ArtifactBrowserPartition.Default,
                  className: 'h-full w-full bg-white',
                  allowpopups: 'false',
                })}
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center overflow-auto px-6 py-10">
          <div className="w-full max-w-[420px]">
            <div className="mb-3 flex items-center justify-between px-1">
              <div className="text-xs text-muted">{t('artifactBrowserLocalServices')}</div>
              <button
                type="button"
                onClick={loadLocalServices}
                className="inline-flex h-6 w-6 items-center justify-center rounded text-muted transition-colors hover:bg-surface hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                title={t('artifactBrowserLocalServicesRefresh')}
                disabled={isLoadingLocalServices}
              >
                <RefreshIcon />
              </button>
            </div>
            {localServices.length > 0 ? (
              <div className="space-y-2">
                {localServices.map(service => (
                  <button
                    key={service.id}
                    type="button"
                    onClick={() => handleOpenLocalService(service)}
                    className="group flex w-full items-center gap-3 rounded-lg border border-border bg-background p-2 text-left transition-colors hover:border-primary/35 hover:bg-surface"
                  >
                    <div className="flex h-[52px] w-[84px] shrink-0 flex-col overflow-hidden rounded-md border border-border bg-surface shadow-sm">
                      <div className="flex h-3 items-center gap-1 border-b border-border px-2">
                        <span className="h-1.5 w-1.5 rounded-full bg-red-400/70" />
                        <span className="h-1.5 w-1.5 rounded-full bg-yellow-400/70" />
                        <span className="h-1.5 w-1.5 rounded-full bg-green-400/70" />
                      </div>
                      <div className="flex flex-1 items-center px-2 text-[8px] leading-tight text-muted">
                        <span className="line-clamp-2">{service.title}</span>
                      </div>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-foreground">
                        {service.title}
                      </div>
                      <div className="truncate text-xs text-muted">
                        {service.host}:{service.port}
                      </div>
                    </div>
                    <span
                      className={`h-2 w-2 shrink-0 rounded-full ${service.online ? 'bg-emerald-400' : 'bg-muted'}`}
                      title={service.online ? t('artifactBrowserLocalServiceOnline') : undefined}
                    />
                  </button>
                ))}
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted">
                {isLoadingLocalServices
                  ? t('artifactBrowserLocalServicesLoading')
                  : t('artifactBrowserLocalServicesEmpty')}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

const FolderIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M2 4.5A1.5 1.5 0 013.5 3h2.879a1.5 1.5 0 011.06.44l.622.62a1.5 1.5 0 001.06.44H12.5A1.5 1.5 0 0114 6v5.5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5v-7z" />
  </svg>
);

const BrowserIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="8" cy="8" r="6" />
    <ellipse cx="8" cy="8" rx="2.5" ry="6" />
    <path d="M2 8h12" />
  </svg>
);

const ShareUploadIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M2 11v1.5A1.5 1.5 0 0 0 3.5 14h9a1.5 1.5 0 0 0 1.5-1.5V11" />
    <path d="M5 5l3-3 3 3" />
    <path d="M8 2v9" />
  </svg>
);

const AnnotateIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M13.4 9.8a1.9 1.9 0 01-1.9 1.9H6l-3.4 2.9V4.8a1.9 1.9 0 011.9-1.9h7a1.9 1.9 0 011.9 1.9z" />
    <path d="M8 5.2v4.2M5.9 7.3h4.2" />
  </svg>
);

const ChevronLeftIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M10 3L5 8l5 5" />
  </svg>
);

const ChevronRightBrowserIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M6 3l5 5-5 5" />
  </svg>
);

const StopIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M4.25 4.25h7.5v7.5h-7.5z" />
  </svg>
);

const OpenExternalIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M12 9v3.5a1.5 1.5 0 01-1.5 1.5h-7A1.5 1.5 0 012 12.5v-7A1.5 1.5 0 013.5 4H7" />
    <path d="M10 2h4v4" />
    <path d="M7 9l7-7" />
  </svg>
);

const BrowserAddressOpenExternalIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.35"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M4.75 11.25l6.5-6.5" />
    <path d="M7.75 4.75h3.5v3.5" />
  </svg>
);

const MoreHorizontalToolbarIcon = () => (
  <svg width="16" height="14" viewBox="0 0 16 14" fill="currentColor" aria-hidden="true">
    <circle cx="4" cy="8.6" r="1.15" />
    <circle cx="8" cy="8.6" r="1.15" />
    <circle cx="12" cy="8.6" r="1.15" />
  </svg>
);

const ContentViewIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M2.5 3.5h11" />
    <path d="M2.5 8h11" />
    <path d="M2.5 12.5h6" />
  </svg>
);

const FileListIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M4.5 2.881c0-.644.522-1.167 1.167-1.167h2.552c.323 0 .635.117.878.33l.58.507c.243.213.555.33.877.33h3.351c.736 0 1.333.597 1.333 1.333v5.945c0 .49-.398.889-.889.889" />
    <path d="M1.143 6.476c0-.736.597-1.333 1.333-1.333h2.314c.323 0 .635.117.878.33l.58.507c.242.213.554.33.877.33h3.351c.736 0 1.333.597 1.333 1.334v4.833c0 .736-.597 1.333-1.333 1.333H2.476c-.736 0-1.333-.597-1.333-1.333V6.476z" />
  </svg>
);

const RefreshIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M13.5 8a5.5 5.5 0 01-9.55 3.75" />
    <path d="M2.5 8a5.5 5.5 0 019.55-3.75" />
    <path d="M12.05 1.25v3h-3" />
    <path d="M3.95 14.75v-3h3" />
  </svg>
);

const MoreVerticalIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <circle cx="8" cy="3.5" r="1.1" />
    <circle cx="8" cy="8" r="1.1" />
    <circle cx="8" cy="12.5" r="1.1" />
  </svg>
);

const MinusIcon = () => (
  <svg
    width="13"
    height="13"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <path d="M4 8h8" />
  </svg>
);

const PlusIcon = () => (
  <svg
    width="13"
    height="13"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <path d="M8 4v8" />
    <path d="M4 8h8" />
  </svg>
);

const RotateDeviceIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M5.5 2.5h5A1.5 1.5 0 0112 4v8a1.5 1.5 0 01-1.5 1.5h-5A1.5 1.5 0 014 12V4a1.5 1.5 0 011.5-1.5z" />
    <path d="M7 4h2" />
    <path d="M7.5 12h1" />
    <path d="M14 8a6 6 0 01-1.76 4.24" />
    <path d="M13.5 9.9L12.24 12.24 9.9 11" />
  </svg>
);

const CloseIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <path d="M4.5 4.5l7 7" />
    <path d="M11.5 4.5l-7 7" />
  </svg>
);

export default ArtifactPanel;
