import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { AgentId } from '@shared/agent';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSelector } from 'react-redux';

import { agentService } from '../services/agent';
import { coworkService } from '../services/cowork';
import { i18nService } from '../services/i18n';
import { RootState } from '../store';
import {
  selectCoworkSessions,
  selectCurrentSessionId,
} from '../store/selectors/coworkSelectors';
import type { CoworkSessionSummary } from '../types/cowork';
import { getAgentDisplayNameById } from '../utils/agentDisplay';
import {
  type AgentSidebarBatchItem,
  AgentSidebarBatchItemKind,
  createSessionBatchKey,
} from './agentSidebar/batchSelection';
import MyAgentSidebarTree from './agentSidebar/MyAgentSidebarTree';
import SidebarTaskFilterButton, { SIDEBAR_TASK_FILTER_ENABLED } from './agentSidebar/SidebarTaskFilterButton';
import SidebarTaskSearchButton from './agentSidebar/SidebarTaskSearchButton';
import Modal from './common/Modal';
import {
  type CoworkTaskSearchRequestEventDetail,
  CoworkTaskSearchRequestSource,
  CoworkUiEvent,
} from './cowork/constants';
import CoworkSearchModal from './cowork/CoworkSearchModal';
import Cog6ToothIcon from './icons/Cog6ToothIcon';
import ComposeIcon from './icons/ComposeIcon';
import SidebarAutomationIcon from './icons/SidebarAutomationIcon';
import SidebarKitsIcon from './icons/SidebarKitsIcon';
import SidebarLibraryIcon from './icons/SidebarLibraryIcon';
import SidebarToggleIcon from './icons/SidebarToggleIcon';
import SkillIcon from './icons/SkillIcon';
import TrashIcon from './icons/TrashIcon';

interface SidebarProps {
  onShowSettings: () => void;
  onShowLogin?: () => void;
  activeView: 'cowork' | 'skills' | 'scheduledTasks' | 'kits' | 'mcp' | 'library';
  onShowSkills: () => void;
  onShowCowork: () => void;
  onShowScheduledTasks: () => void;
  onShowKits: () => void;
  onShowLibrary: () => void;
  onNewChat: () => void;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  isTaskFilterActive: boolean;
  hasUnreadCompletedTasks: boolean;
  onToggleTaskFilter: () => void;
  onTaskFilterSummaryChange: (hasUnreadCompletedTasks: boolean) => void;
  onWidthChange?: (width: number) => void;
  updateNotice?: React.ReactNode;
  hideLogin?: boolean;
  isEngineStartupOverlayVisible?: boolean;
}

const DEFAULT_SIDEBAR_WIDTH = 260;
const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 420;
const SIDEBAR_COLLAPSE_TRANSITION_MS = 200;

const normalizeAgentId = (agentId?: string | null) => agentId?.trim() || AgentId.Main;
const SidebarNewFeatureBadge = {
  KitsDismissedVersionKey: 'sidebar.kitsNewFeatureBadge.dismissedVersion',
  // Bump this value in a release when the kits entry should show the badge again.
  KitsVersion: '2026-06-05',
} as const;
const sidebarNavItemClassName =
  'w-full inline-flex h-9 items-center gap-2.5 rounded-full px-2 text-left text-[length:var(--lobster-text-sidebarCompact)] font-normal text-foreground transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.04]';
const activeSidebarNavItemClassName =
  `${sidebarNavItemClassName} bg-black/[0.05] hover:bg-black/[0.05] dark:bg-white/[0.07] dark:hover:bg-white/[0.07]`;
const sidebarNavIconClassName = 'h-[18px] w-[18px] shrink-0 text-foreground/75';
const sidebarBottomIconButtonClassName =
  'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-foreground/80 transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.04]';

const writeSidebarRendererLog = (
  level: 'debug' | 'warn',
  message: string,
  error?: unknown,
): void => {
  try {
    window.electron?.log?.fromRenderer?.(level, 'Sidebar', message);
  } catch (logError) {
    const logErrorMessage = logError instanceof Error ? logError.message : String(logError);
    console.debug(`[Sidebar] renderer log unavailable: ${logErrorMessage}`, error);
  }
};

const logTaskSearchRequest = (
  source: CoworkTaskSearchRequestSource,
  activeView: SidebarProps['activeView'],
): void => {
  try {
    const message = `task search requested source=${source} activeView=${activeView} platform=${window.electron?.platform ?? 'unknown'}`;
    console.debug(`[Sidebar] ${message}`);
    writeSidebarRendererLog('debug', message);
  } catch (error) {
    // Task search must remain available when renderer diagnostic logging fails.
    console.debug('[Sidebar] task search diagnostic logging unavailable:', error);
  }
};

const Sidebar: React.FC<SidebarProps> = ({
  onShowSettings,
  activeView,
  onShowSkills,
  onShowCowork,
  onShowScheduledTasks,
  onShowKits,
  onShowLibrary,
  onNewChat,
  isCollapsed,
  onToggleCollapse,
  isTaskFilterActive,
  hasUnreadCompletedTasks,
  onToggleTaskFilter,
  onTaskFilterSummaryChange,
  onWidthChange,
  updateNotice,
}) => {
  const currentAgentId = useSelector((state: RootState) => state.agent.currentAgentId);
  const agents = useSelector((state: RootState) => state.agent.agents);
  const sessions = useSelector(selectCoworkSessions);
  const currentSessionId = useSelector(selectCurrentSessionId);
  // The home page is the "new task" view, so its nav item reads as selected there.
  const isNewTaskViewActive = activeView === 'cowork' && !currentSessionId;
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isBatchMode, setIsBatchMode] = useState(false);
  const [batchAgentId, setBatchAgentId] = useState<string | null>(null);
  const [batchSelectableItems, setBatchSelectableItems] = useState<AgentSidebarBatchItem[]>([]);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [deletedSessionIds, setDeletedSessionIds] = useState<string[]>([]);
  const [showBatchDeleteConfirm, setShowBatchDeleteConfirm] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [isResizing, setIsResizing] = useState(false);
  const [agentScrollEdges, setAgentScrollEdges] = useState({ top: false, bottom: false });
  const [showKitsNewBadge, setShowKitsNewBadge] = useState(false);
  const isResizingRef = useRef(false);
  const resizeStartXRef = useRef(0);
  const resizeStartWidthRef = useRef(DEFAULT_SIDEBAR_WIDTH);
  const agentScrollContainerRef = useRef<HTMLDivElement>(null);
  const isWindows = window.electron.platform === 'win32';
  const showHeaderRow = !isWindows;
  const batchSelectableKeySet = useMemo(
    () => new Set(batchSelectableItems.map((item) => item.key)),
    [batchSelectableItems],
  );
  const batchSelectableItemByKey = useMemo(() => {
    const itemByKey = new Map<string, AgentSidebarBatchItem>();
    batchSelectableItems.forEach((item) => itemByKey.set(item.key, item));
    return itemByKey;
  }, [batchSelectableItems]);
  const selectedBatchSelectableCount = useMemo(() => {
    return batchSelectableItems.filter((item) => selectedKeys.has(item.key)).length;
  }, [batchSelectableItems, selectedKeys]);
  const isBatchSelectAllChecked =
    batchSelectableItems.length > 0 && selectedBatchSelectableCount === batchSelectableItems.length;
  const batchAgentName = batchAgentId ? getAgentDisplayNameById(batchAgentId, agents) : null;

  useEffect(() => {
    let isCurrent = true;

    const loadKitsNewBadgeState = async () => {
      try {
        const dismissedVersion = await window.electron.store.get(
          SidebarNewFeatureBadge.KitsDismissedVersionKey,
        );
        if (!isCurrent) return;
        setShowKitsNewBadge(dismissedVersion !== SidebarNewFeatureBadge.KitsVersion);
      } catch (error) {
        console.warn('[Sidebar] failed to load kits new feature badge state:', error);
      }
    };

    void loadKitsNewBadgeState();

    return () => {
      isCurrent = false;
    };
  }, []);

  const dismissKitsNewBadge = useCallback(() => {
    if (!showKitsNewBadge) return;
    setShowKitsNewBadge(false);
    void window.electron.store
      .set(
        SidebarNewFeatureBadge.KitsDismissedVersionKey,
        SidebarNewFeatureBadge.KitsVersion,
      )
      .catch((error) => {
        console.warn('[Sidebar] failed to save kits new feature badge state:', error);
      });
  }, [showKitsNewBadge]);

  const openTaskSearch = useCallback((source: CoworkTaskSearchRequestSource) => {
    logTaskSearchRequest(source, activeView);
    onShowCowork();
    setIsSearchOpen(true);
  }, [activeView, onShowCowork]);

  useEffect(() => {
    const handleSearch = (event: Event) => {
      const detail = (event as CustomEvent<CoworkTaskSearchRequestEventDetail>).detail;
      openTaskSearch(detail?.source ?? CoworkTaskSearchRequestSource.UiEvent);
    };
    window.addEventListener(CoworkUiEvent.ShortcutSearch, handleSearch);
    return () => {
      window.removeEventListener(CoworkUiEvent.ShortcutSearch, handleSearch);
    };
  }, [openTaskSearch]);

  useEffect(() => {
    if (!isCollapsed) return;
    setIsSearchOpen(false);
    setIsBatchMode(false);
    setBatchAgentId(null);
    setBatchSelectableItems([]);
    setSelectedKeys(new Set());
    setShowBatchDeleteConfirm(false);
  }, [isCollapsed]);

  const handleSelectSession = async (session: CoworkSessionSummary) => {
    const agentId = session.agentId?.trim() || AgentId.Main;
    try {
      if (agentId !== currentAgentId) {
        agentService.switchAgent(agentId, { targetSessionId: session.id });
        await coworkService.loadSessions(agentId);
      }
      onShowCowork();
      await coworkService.loadSession(session.id);
    } finally {
      coworkService.finishSessionNavigation(session.id);
    }
  };

  const handleEnterBatchMode = useCallback((sessionId: string, agentId: string) => {
    setIsBatchMode(true);
    setBatchAgentId(agentId);
    setBatchSelectableItems([]);
    setSelectedKeys(new Set([createSessionBatchKey(sessionId)]));
  }, []);

  const handleExitBatchMode = useCallback(() => {
    setIsBatchMode(false);
    setBatchAgentId(null);
    setBatchSelectableItems([]);
    setSelectedKeys(new Set());
    setShowBatchDeleteConfirm(false);
  }, []);

  const handleBatchSelectableItemsChange = useCallback((items: AgentSidebarBatchItem[]) => {
    setBatchSelectableItems(items);
    setSelectedKeys((previous) => {
      if (!batchAgentId || items.length === 0) return previous;
      const itemKeySet = new Set(items.map((item) => item.key));
      const next = new Set(Array.from(previous).filter((key) => itemKeySet.has(key)));
      return next.size === previous.size ? previous : next;
    });
  }, [batchAgentId]);

  const updateAgentScrollEdges = useCallback((element: HTMLDivElement | null) => {
    if (!element) {
      setAgentScrollEdges((previousEdges) => (
        previousEdges.top || previousEdges.bottom ? { top: false, bottom: false } : previousEdges
      ));
      return;
    }

    const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
    const nextEdges = {
      top: element.scrollTop > 1,
      bottom: maxScrollTop - element.scrollTop > 1,
    };

    setAgentScrollEdges((previousEdges) => {
      if (previousEdges.top === nextEdges.top && previousEdges.bottom === nextEdges.bottom) {
        return previousEdges;
      }
      return nextEdges;
    });
  }, []);

  const handleAgentScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    updateAgentScrollEdges(event.currentTarget);
  }, [updateAgentScrollEdges]);

  const handleToggleSelection = useCallback((selectionKey: string, agentId: string) => {
    if (batchAgentId && normalizeAgentId(agentId) !== batchAgentId) return;
    setSelectedKeys(prev => {
      const next = new Set(prev);
      if (next.has(selectionKey)) {
        next.delete(selectionKey);
      } else {
        next.add(selectionKey);
      }
      return next;
    });
  }, [batchAgentId]);

  const handleSelectAll = useCallback(() => {
    if (batchSelectableItems.length === 0) return;
    setSelectedKeys(prev => {
      const selectedVisibleCount = batchSelectableItems.filter((item) => prev.has(item.key)).length;
      if (selectedVisibleCount === batchSelectableItems.length) {
        return new Set();
      }
      return new Set(batchSelectableItems.map((item) => item.key));
    });
  }, [batchSelectableItems]);

  const handleBatchDeleteClick = useCallback(() => {
    if (selectedKeys.size === 0) return;
    setShowBatchDeleteConfirm(true);
  }, [selectedKeys.size]);

  const handleBatchDelete = useCallback(async () => {
    if (selectedKeys.size === 0) return;
    const items = Array.from(selectedKeys)
      .filter((key) => batchSelectableKeySet.size === 0 || batchSelectableKeySet.has(key))
      .map((key) => batchSelectableItemByKey.get(key))
      .filter((item): item is AgentSidebarBatchItem => Boolean(item));
    if (items.length === 0) return;

    const sessionIds = items
      .filter((item) => item.kind === AgentSidebarBatchItemKind.Session)
      .map((item) => item.sessionId);

    let deletedSessions = false;
    if (sessionIds.length > 0) {
      deletedSessions = await coworkService.deleteSessions(sessionIds);
    }

    if (!deletedSessions) {
      return;
    }
    if (deletedSessions) {
      setDeletedSessionIds(sessionIds);
    }
    handleExitBatchMode();
  }, [
    batchSelectableItemByKey,
    batchSelectableKeySet,
    selectedKeys,
    handleExitBatchMode,
  ]);

  const handleResizeStart = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (isCollapsed) return;
    event.preventDefault();
    isResizingRef.current = true;
    setIsResizing(true);
    resizeStartXRef.current = event.clientX;
    resizeStartWidthRef.current = sidebarWidth;
    document.body.classList.add('select-none');

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (!isResizingRef.current) return;
      const nextWidth = resizeStartWidthRef.current + moveEvent.clientX - resizeStartXRef.current;
      if (nextWidth < MIN_SIDEBAR_WIDTH) {
        isResizingRef.current = false;
        setIsResizing(false);
        document.body.classList.remove('select-none');
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
        onToggleCollapse();
        return;
      }
      const clampedWidth = Math.min(MAX_SIDEBAR_WIDTH, nextWidth);
      setSidebarWidth(clampedWidth);
      onWidthChange?.(clampedWidth);
    };

    const handleMouseUp = () => {
      isResizingRef.current = false;
      setIsResizing(false);
      document.body.classList.remove('select-none');
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [isCollapsed, onToggleCollapse, onWidthChange, sidebarWidth]);

  useEffect(() => {
    return () => {
      document.body.classList.remove('select-none');
    };
  }, []);

  useEffect(() => {
    const element = agentScrollContainerRef.current;
    if (!element) return;

    updateAgentScrollEdges(element);

    const resizeObserver = new ResizeObserver(() => updateAgentScrollEdges(element));
    resizeObserver.observe(element);
    if (element.firstElementChild) {
      resizeObserver.observe(element.firstElementChild);
    }

    return () => {
      resizeObserver.disconnect();
    };
  }, [updateAgentScrollEdges]);

  return (
    <aside
      data-skin-sidebar="true"
      className={`relative shrink-0 overflow-hidden bg-surface-raised ${
        isResizing ? '' : 'sidebar-transition'
      }`}
      style={{ width: isCollapsed ? 0 : sidebarWidth }}
    >
      <div
        className={`flex h-full flex-col transition-opacity ease-out ${
          isCollapsed ? 'pointer-events-none opacity-0' : 'opacity-100'
        }`}
        style={{
          width: sidebarWidth,
          transitionDuration: `${SIDEBAR_COLLAPSE_TRANSITION_MS}ms`,
        }}
      >
      <div className="pt-3 pb-3">
        {showHeaderRow && (
          <div className="draggable sidebar-header-drag h-8 flex items-center justify-end px-3">
            {!isWindows && (
              <>
                <button
                  type="button"
                  onClick={onToggleCollapse}
                  className="non-draggable h-8 w-8 inline-flex items-center justify-center rounded-lg text-foreground/80 hover:bg-black/[0.03] dark:hover:bg-white/[0.04] transition-colors"
                  aria-label={isCollapsed ? i18nService.t('expand') : i18nService.t('collapse')}
                >
                  <SidebarToggleIcon className="h-[18px] w-[18px]" isCollapsed={isCollapsed} />
                </button>
                {!isCollapsed && (
                  <>
                    <SidebarTaskSearchButton
                      onClick={() => {
                        openTaskSearch(CoworkTaskSearchRequestSource.SidebarHeader);
                      }}
                      className="non-draggable"
                      label={i18nService.t('search')}
                    />
                    {SIDEBAR_TASK_FILTER_ENABLED && activeView === 'cowork' && (
                      <SidebarTaskFilterButton
                        isActive={isTaskFilterActive}
                        hasUnreadCompletedTasks={hasUnreadCompletedTasks}
                        label={i18nService.t('sidebarFilter')}
                        onClick={onToggleTaskFilter}
                        className="non-draggable"
                      />
                    )}
                  </>
                )}
              </>
            )}
          </div>
        )}
        <div className="mt-[5px] space-y-0.5 px-3">
          <button
            type="button"
            data-onboarding-target="new-task"
            onClick={() => {
              onNewChat();
            }}
            className={isNewTaskViewActive ? activeSidebarNavItemClassName : sidebarNavItemClassName}
            aria-current={isNewTaskViewActive ? 'page' : undefined}
          >
            <ComposeIcon className={sidebarNavIconClassName} />
            {i18nService.t('newChat')}
          </button>
          <button
            type="button"
            onClick={() => {
              setIsSearchOpen(false);
              onShowScheduledTasks();
            }}
            className={activeView === 'scheduledTasks' ? activeSidebarNavItemClassName : sidebarNavItemClassName}
            aria-current={activeView === 'scheduledTasks' ? 'page' : undefined}
          >
            <SidebarAutomationIcon className={sidebarNavIconClassName} />
            {i18nService.t('scheduledTasks')}
          </button>
          <button
            type="button"
            onClick={() => {
              setIsSearchOpen(false);
              dismissKitsNewBadge();
              onShowKits();
            }}
            className={activeView === 'kits' ? activeSidebarNavItemClassName : sidebarNavItemClassName}
            aria-current={activeView === 'kits' ? 'page' : undefined}
          >
            <SidebarKitsIcon className={sidebarNavIconClassName} />
            <span className="min-w-0 truncate">{i18nService.t('kits')}</span>
            {showKitsNewBadge && (
              <span className="inline-flex h-4 shrink-0 items-center rounded-[4px] bg-[#ff4f6d] px-1.5 text-[10px] font-semibold leading-none text-white">
                {i18nService.t('newFeatureBadge')}
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={() => {
              setIsSearchOpen(false);
              onShowSkills();
            }}
            className={activeView === 'skills' || activeView === 'mcp' ? activeSidebarNavItemClassName : sidebarNavItemClassName}
            aria-current={activeView === 'skills' || activeView === 'mcp' ? 'page' : undefined}
          >
            <SkillIcon className={sidebarNavIconClassName} />
            <span className="min-w-0 truncate">{i18nService.t('skillsAndConnectors')}</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setIsSearchOpen(false);
              onShowLibrary();
            }}
            className={activeView === 'library' ? activeSidebarNavItemClassName : sidebarNavItemClassName}
            aria-current={activeView === 'library' ? 'page' : undefined}
          >
            <SidebarLibraryIcon className={sidebarNavIconClassName} />
            <span className="min-w-0 truncate">{i18nService.t('librarySidebarTitle')}</span>
          </button>
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        <div
          ref={agentScrollContainerRef}
          className="scrollbar-hidden h-full overflow-y-auto px-[18px] pb-10"
          onScroll={handleAgentScroll}
        >
          <MyAgentSidebarTree
            isBatchMode={isBatchMode}
            batchAgentId={batchAgentId}
            deletedSessionIds={deletedSessionIds}
            selectedKeys={selectedKeys}
            isTaskFilterActive={isTaskFilterActive}
            onShowCowork={onShowCowork}
            onTaskFilterSummaryChange={onTaskFilterSummaryChange}
            onToggleSelection={handleToggleSelection}
            onEnterBatchMode={handleEnterBatchMode}
            onBatchSelectableItemsChange={handleBatchSelectableItemsChange}
          />
        </div>
        <div
          className={`pointer-events-none absolute inset-x-0 top-0 z-10 h-24 bg-gradient-to-b from-surface-raised to-transparent transition-opacity duration-150 ${
            agentScrollEdges.top ? 'opacity-100' : 'opacity-0'
          }`}
        />
        <div
          className={`pointer-events-none absolute inset-x-0 top-[68px] z-10 h-3 bg-gradient-to-b from-surface-raised to-transparent transition-opacity duration-150 ${
            agentScrollEdges.top ? 'opacity-40' : 'opacity-0'
          }`}
        />
      </div>
      {!isCollapsed && (
        <div
          className="non-draggable absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-primary/30 active:bg-primary/50 transition-colors"
          onMouseDown={handleResizeStart}
        />
      )}
      <CoworkSearchModal
        isOpen={isSearchOpen}
        onClose={() => setIsSearchOpen(false)}
        sessions={sessions}
        currentSessionId={currentSessionId}
        onSelectSession={handleSelectSession}
      />
      {!isBatchMode && updateNotice && (
        <div className="non-draggable px-3 pt-1.5">
          <div>{updateNotice}</div>
        </div>
      )}
      {isBatchMode ? (
        <div className="border-t border-border/60 px-3 pb-3 pt-2">
          <div className="mb-2 flex min-w-0 items-center justify-between gap-2">
            <span className="min-w-0 truncate text-xs text-secondary">
              {i18nService
                .t('batchSelectionScope')
                .replace('{agent}', batchAgentName ?? '')
                .replace('{count}', String(selectedKeys.size))}
            </span>
            <button
              type="button"
              onClick={handleExitBatchMode}
              className="shrink-0 rounded-md px-1.5 py-1 text-xs font-medium text-secondary transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
            >
              {i18nService.t('batchCancel')}
            </button>
          </div>
          <div className="flex items-center gap-2">
            <label className="inline-flex h-7 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-1.5 text-[length:var(--lobster-text-sidebarCompact)] font-normal text-foreground transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.04]">
              <input
                type="checkbox"
                checked={isBatchSelectAllChecked}
                onChange={handleSelectAll}
                disabled={batchSelectableItems.length === 0}
                className="h-3.5 w-3.5 shrink-0 rounded border-gray-300 accent-primary disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600"
              />
              <span className="truncate">{i18nService.t('batchSelectAll')}</span>
            </label>
            <button
              type="button"
              onClick={handleBatchDeleteClick}
              disabled={selectedKeys.size === 0}
              className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[13px] font-medium transition-colors ${
                selectedKeys.size > 0
                  ? 'bg-red-500 text-white hover:bg-red-600'
                  : 'cursor-not-allowed bg-gray-200 text-gray-400 dark:bg-gray-700 dark:text-gray-500'
              }`}
            >
              <TrashIcon className="h-3.5 w-3.5" />
              {i18nService.t('batchDelete')} ({selectedKeys.size})
            </button>
          </div>
        </div>
      ) : (
        <div className="pb-2.5 pt-2">

          <div className="flex items-end pl-3 pr-2 pt-1">
            <div className="ml-auto flex shrink-0 items-center justify-end">
              <button
                type="button"
                onClick={() => onShowSettings()}
                className={sidebarBottomIconButtonClassName}
                aria-label={i18nService.t('settings')}
              >
                <Cog6ToothIcon className="h-[18px] w-[18px] shrink-0" />
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Batch Delete Confirmation Modal */}
      {showBatchDeleteConfirm && (
        <Modal
          onClose={() => {
            setShowBatchDeleteConfirm(false);
          }}
          className="w-full max-w-sm mx-4 bg-surface rounded-2xl shadow-xl overflow-hidden"
        >
          <div className="flex items-center gap-3 px-5 py-4">
            <div className="p-2 rounded-full bg-red-100 dark:bg-red-900/30">
              <ExclamationTriangleIcon className="h-5 w-5 text-red-600 dark:text-red-500" />
            </div>
            <h2 className="text-base font-semibold text-foreground">
              {i18nService.t('batchDeleteConfirmTitle')}
            </h2>
          </div>
          <div className="px-5 pb-4">
            <p className="text-sm text-secondary">
              {i18nService
                .t('batchDeleteConfirmMessage')
                .replace('{count}', String(selectedKeys.size))}
            </p>
          </div>
          <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-border">
            <button
              onClick={() => {
                setShowBatchDeleteConfirm(false);
              }}
              className="px-4 py-2 text-sm font-medium rounded-lg text-secondary hover:bg-surface-raised transition-colors"
            >
              {i18nService.t('cancel')}
            </button>
            <button
              onClick={handleBatchDelete}
              className="px-4 py-2 text-sm font-medium rounded-lg bg-red-500 hover:bg-red-600 text-white transition-colors"
            >
              {i18nService.t('batchDelete')} ({selectedKeys.size})
            </button>
          </div>
        </Modal>
      )}
      </div>
    </aside>
  );
};

export default Sidebar;
