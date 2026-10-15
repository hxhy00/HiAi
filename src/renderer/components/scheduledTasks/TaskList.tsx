import {
  ClockIcon,
  EllipsisVerticalIcon,
  PlayIcon,
  PlusIcon,
} from '@heroicons/react/24/outline';
import React from 'react';
import { createPortal } from 'react-dom';
import { useDispatch, useSelector } from 'react-redux';

import { ScheduledTaskDataStatus } from '../../../scheduledTask/constants';
import type { ScheduledTask } from '../../../scheduledTask/types';
import { i18nService } from '../../services/i18n';
import { scheduledTaskService } from '../../services/scheduledTask';
import { RootState } from '../../store';
import { selectTask, setViewMode } from '../../store/slices/scheduledTaskSlice';
import ManagementListRow, { MANAGEMENT_LIST_CONTAINER_CLASS } from '../common/ManagementListRow';
import { MANAGEMENT_BODY_TEXT, MANAGEMENT_TITLE_TEXT } from '../common/managementTypography';
import EditIcon from '../icons/EditIcon';
import TrashIcon from '../icons/TrashIcon';

import ScheduledTaskDataState from './ScheduledTaskDataState';
import TaskStatusChip from './TaskStatusChip';
import {
  SCHEDULED_TASK_TEMPLATES,
  type ScheduledTaskTemplate,
  templateIconComponents,
} from './taskTemplates';
import TaskToggle from './TaskToggle';
import {
  formatDateTimeMinute,
  formatNextRunRelative,
  formatScheduleLabel,
  getTaskDisplayStatus,
  getTaskPromptText,
} from './utils';

/** Template gallery grid — the task list itself is a single-column list. */
const templateGalleryGridClass = 'grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-3';
const menuWidthPx = 144;
const menuHeightEstimatePx = 156;
const menuEdgeGapPx = 8;
const menuTriggerGapPx = 4;
const menuItemClassName =
  `flex w-full items-center gap-2 whitespace-nowrap px-3 py-2 text-left ${MANAGEMENT_BODY_TEXT} text-foreground transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.05]`;
const destructiveMenuItemClassName =
  `flex w-full items-center gap-2 whitespace-nowrap px-3 py-2 text-left ${MANAGEMENT_BODY_TEXT} text-red-500 transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.05]`;
const menuIconClassName = 'h-3.5 w-3.5';

interface MenuPosition {
  top: number;
  left: number;
}

interface TaskCardProps {
  task: ScheduledTask;
  onRequestDelete: (taskId: string, taskName: string, source?: string) => void;
}

const TaskCard: React.FC<TaskCardProps> = ({ task, onRequestDelete }) => {
  const dispatch = useDispatch();
  const [showMenu, setShowMenu] = React.useState(false);
  const [menuPosition, setMenuPosition] = React.useState<MenuPosition | null>(null);
  const menuButtonRef = React.useRef<HTMLButtonElement>(null);
  const menuRef = React.useRef<HTMLDivElement>(null);

  const updateMenuPosition = React.useCallback(() => {
    if (!menuButtonRef.current) return;

    const rect = menuButtonRef.current.getBoundingClientRect();
    const maxLeft = window.innerWidth - menuWidthPx - menuEdgeGapPx;
    const left = Math.max(
      menuEdgeGapPx,
      Math.min(rect.right - menuWidthPx, maxLeft),
    );
    const spaceBelow = window.innerHeight - rect.bottom;
    const hasMoreSpaceAbove = rect.top > spaceBelow;
    const openAbove = spaceBelow < menuHeightEstimatePx + menuTriggerGapPx && hasMoreSpaceAbove;
    const preferredTop = openAbove
      ? rect.top - menuHeightEstimatePx - menuTriggerGapPx
      : rect.bottom + menuTriggerGapPx;
    const maxTop = window.innerHeight - menuHeightEstimatePx - menuEdgeGapPx;

    setMenuPosition({
      top: Math.max(menuEdgeGapPx, Math.min(preferredTop, maxTop)),
      left,
    });
  }, []);

  React.useLayoutEffect(() => {
    if (showMenu) {
      updateMenuPosition();
    } else {
      setMenuPosition(null);
    }
  }, [showMenu, updateMenuPosition]);

  React.useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        menuButtonRef.current &&
        !menuButtonRef.current.contains(target) &&
        menuRef.current &&
        !menuRef.current.contains(target)
      ) {
        setShowMenu(false);
      }
    };
    if (showMenu) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showMenu]);

  React.useEffect(() => {
    if (!showMenu) return;

    const handleViewportChange = () => setShowMenu(false);
    window.addEventListener('resize', handleViewportChange);
    document.addEventListener('scroll', handleViewportChange, true);

    return () => {
      window.removeEventListener('resize', handleViewportChange);
      document.removeEventListener('scroll', handleViewportChange, true);
    };
  }, [showMenu]);

  const displayStatus = getTaskDisplayStatus(task);
  const isRunning = displayStatus === 'running';
  const promptText = getTaskPromptText(task);
  const nextRunLabel = task.enabled ? formatNextRunRelative(task.state.nextRunAtMs) : null;

  const handleSelectTask = React.useCallback(() => {
    dispatch(selectTask(task.id));
  }, [dispatch, task.id]);

  const handleToggleTask = React.useCallback(async () => {
    const targetEnabled = !task.enabled;
    try {
      await scheduledTaskService.toggleTask(task.id, targetEnabled);
    } catch {
      // The service already rolled back the optimistic flip and toasted.
    }
  }, [task.enabled, task.id]);

  const handleRunManually = React.useCallback(async () => {
    try {
      await scheduledTaskService.runManually(task.id);
    } catch {
    }
  }, [task.id]);

  return (
    <ManagementListRow
      title={task.name}
      titleClassName={task.enabled ? '' : 'text-secondary'}
      badges={(
        <TaskStatusChip
          status={displayStatus}
          title={
            task.state.lastRunAtMs
              ? `${i18nService.t('scheduledTasksLastRun')} · ${formatDateTimeMinute(new Date(task.state.lastRunAtMs))}`
              : undefined
          }
        />
      )}
      subtitle={(
        <span className="flex min-w-0 items-center gap-1.5">
          <ClockIcon className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">
            {formatScheduleLabel(task.schedule)}
            {nextRunLabel && <span className="text-secondary/60"> · {nextRunLabel}</span>}
            <span className="text-secondary/60"> · </span>
            <span>{task.description || promptText}</span>
          </span>
        </span>
      )}
      right={(
        <>
          <TaskToggle
            enabled={task.enabled}
            onToggle={() => void handleToggleTask()}
            title={i18nService.t(task.enabled ? 'scheduledTasksEnabled' : 'scheduledTasksDisabled')}
          />
          <div className="relative">
            <button
              ref={menuButtonRef}
              type="button"
              aria-label={i18nService.t('scheduledTasksMoreActions')}
              title={i18nService.t('scheduledTasksMoreActions')}
              onClick={event => {
                event.stopPropagation();
                setShowMenu(value => {
                  const nextShowMenu = !value;
                  if (nextShowMenu) {
                  }
                  return nextShowMenu;
                });
              }}
              className="rounded-md p-1 text-secondary/70 transition-colors hover:bg-surface-raised hover:text-foreground"
            >
              <EllipsisVerticalIcon className="h-4 w-4" />
            </button>
            {showMenu && menuPosition && (
              createPortal(
                <div
                  ref={menuRef}
                  onClick={event => event.stopPropagation()}
                  className="fixed z-[9999] w-36 rounded-lg border border-border bg-surface py-1 shadow-lg"
                  style={{ top: menuPosition.top, left: menuPosition.left }}
                >
                  <button
                    type="button"
                    onClick={event => {
                      event.stopPropagation();
                      setShowMenu(false);
                      void handleRunManually();
                    }}
                    disabled={isRunning}
                    className={`${menuItemClassName} disabled:opacity-50`}
                  >
                    <PlayIcon className={menuIconClassName} />
                    {i18nService.t('scheduledTasksRun')}
                  </button>
                  <button
                    type="button"
                    onClick={event => {
                      event.stopPropagation();
                      setShowMenu(false);
                      dispatch(selectTask(task.id));
                      dispatch(setViewMode('edit'));
                    }}
                    className={menuItemClassName}
                  >
                    <EditIcon className={menuIconClassName} />
                    {i18nService.t('scheduledTasksEdit')}
                  </button>
                  <button
                    type="button"
                    onClick={event => {
                      event.stopPropagation();
                      setShowMenu(false);
                      onRequestDelete(task.id, task.name, 'scheduled_tasks_list');
                    }}
                    className={destructiveMenuItemClassName}
                  >
                    <TrashIcon className={menuIconClassName} />
                    {i18nService.t('scheduledTasksDelete')}
                  </button>
                </div>,
                document.body,
              )
            )}
          </div>
        </>
      )}
      onClick={handleSelectTask}
    />
  );
};

interface TemplateGalleryProps {
  onCreateFromTemplate: (template: ScheduledTaskTemplate) => void;
  /** When set, append a dashed "start from scratch" tile to the grid. */
  onCreateBlank?: () => void;
  /** Hide the section label when the gallery is the page's main content. */
  showHeader?: boolean;
}

const TemplateGallery: React.FC<TemplateGalleryProps> = ({
  onCreateFromTemplate,
  onCreateBlank,
  showHeader = true,
}) => (
  <div>
    {showHeader && (
      <div className="mb-3 flex items-center gap-3">
        <span className="text-xs font-medium text-secondary">
          {i18nService.t('scheduledTasksTemplatesSection')}
        </span>
        <div className="h-px flex-1 bg-border-subtle" />
      </div>
    )}
    <div className={templateGalleryGridClass}>
      {SCHEDULED_TASK_TEMPLATES.map(template => {
        const Icon = templateIconComponents[template.icon];
        return (
          <button
            key={template.id}
            type="button"
            onClick={() => onCreateFromTemplate(template)}
            className="group flex items-start gap-3 rounded-xl border border-border bg-surface p-3 text-left shadow-subtle transition hover:border-primary/50 hover:shadow-card"
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-raised text-secondary transition-colors group-hover:bg-primary/10 group-hover:text-primary">
              <Icon className="h-[18px] w-[18px]" />
            </div>
            <div className="min-w-0 flex-1">
              <div className={`truncate ${MANAGEMENT_TITLE_TEXT} font-medium text-foreground`}>
                {i18nService.t(template.titleKey)}
              </div>
              <div className="mt-0.5 text-xs leading-5 text-secondary line-clamp-2">
                {i18nService.t(template.descriptionKey)}
              </div>
              <div className="mt-1.5 flex items-center gap-1 text-xs text-secondary/70">
                <ClockIcon className="h-3 w-3" />
                {i18nService.t(template.scheduleLabelKey)}
              </div>
            </div>
          </button>
        );
      })}
      {onCreateBlank && (
        <button
          type="button"
          onClick={onCreateBlank}
          className="group flex items-start gap-3 rounded-xl border border-dashed border-border p-3 text-left transition hover:border-primary/50 hover:bg-surface"
        >
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-raised text-secondary transition-colors group-hover:bg-primary/10 group-hover:text-primary">
            <PlusIcon className="h-[18px] w-[18px]" />
          </div>
          <div className="min-w-0 flex-1">
            <div className={`truncate ${MANAGEMENT_TITLE_TEXT} font-medium text-foreground`}>
              {i18nService.t('scheduledTasksBlankCreate')}
            </div>
            <div className="mt-0.5 text-xs leading-5 text-secondary line-clamp-2">
              {i18nService.t('scheduledTasksBlankCreateHint')}
            </div>
          </div>
        </button>
      )}
    </div>
  </div>
);

interface TaskListProps {
  /** Search text owned by the page toolbar so it can also drive the history tab. */
  searchText: string;
  onClearSearch: () => void;
  onRequestDelete: (taskId: string, taskName: string, source?: string) => void;
  onCreateNew: () => void;
  onCreateFromTemplate: (template: ScheduledTaskTemplate) => void;
}

const TaskList: React.FC<TaskListProps> = ({
  searchText,
  onClearSearch,
  onRequestDelete,
  onCreateNew,
  onCreateFromTemplate,
}) => {
  const tasks = useSelector((state: RootState) => state.scheduledTask.tasks);
  const status = useSelector((state: RootState) => state.scheduledTask.taskListStatus);
  const error = useSelector((state: RootState) => state.scheduledTask.taskListError);

  // Re-render every 30s so the relative "next run" labels on the cards stay
  // honest while the list is left open.
  const [, setRelativeTimeTick] = React.useState(0);
  React.useEffect(() => {
    const timer = setInterval(() => setRelativeTimeTick(tick => tick + 1), 30_000);
    return () => clearInterval(timer);
  }, []);

  const sortedTasks = React.useMemo(() => {
    const rank = (task: ScheduledTask): number => {
      if (task.state.runningAtMs) return 0;
      if (task.enabled && task.state.nextRunAtMs !== null) return 1;
      if (task.enabled) return 2;
      return 3;
    };
    return [...tasks].sort((a, b) => {
      const rankDiff = rank(a) - rank(b);
      if (rankDiff !== 0) return rankDiff;
      const nextA = a.state.nextRunAtMs ?? Number.MAX_SAFE_INTEGER;
      const nextB = b.state.nextRunAtMs ?? Number.MAX_SAFE_INTEGER;
      if (nextA !== nextB) return nextA - nextB;
      return a.name.localeCompare(b.name);
    });
  }, [tasks]);

  const normalizedSearch = searchText.trim().toLowerCase();
  const visibleTasks = React.useMemo(() => {
    if (!normalizedSearch) return sortedTasks;
    return sortedTasks.filter(task =>
      [task.name, task.description, getTaskPromptText(task)]
        .join('\n')
        .toLowerCase()
        .includes(normalizedSearch),
    );
  }, [normalizedSearch, sortedTasks]);

  if (status === ScheduledTaskDataStatus.Loading) {
    return (
      <div className={MANAGEMENT_LIST_CONTAINER_CLASS} aria-hidden="true">
        {Array.from({ length: 4 }).map((_, idx) => (
          <div key={idx} className="flex items-center gap-3 px-4 py-3">
            <div className="h-4 flex-1 rounded bg-surface-raised" />
            <div className="h-4 w-8 rounded-full bg-surface-raised" />
          </div>
        ))}
      </div>
    );
  }

  if (status !== ScheduledTaskDataStatus.Ready) {
    return (
      <ScheduledTaskDataState
        status={status}
        error={error}
        onRetry={() => {
          void scheduledTaskService.loadTasks();
        }}
      />
    );
  }

  if (tasks.length === 0) {
    return (
      <div className="space-y-5">
        {/* First-run funnel: a compact intro, then templates as the primary creation path. */}
        <div className="flex flex-col items-center pt-4 text-center">
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
            <ClockIcon className="h-6 w-6 text-primary" />
          </div>
          <p className="text-base font-semibold text-foreground">
            {i18nService.t('scheduledTasksEmptyState')}
          </p>
          <p className="mt-1 text-sm text-secondary">
            {i18nService.t('scheduledTasksEmptyHint')}
          </p>
        </div>
        <TemplateGallery
          onCreateFromTemplate={onCreateFromTemplate}
          onCreateBlank={onCreateNew}
          showHeader={false}
        />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {visibleTasks.length === 0 ? (
        <div className="flex flex-col items-center rounded-xl border border-border px-6 py-10 text-center">
          <p className="text-sm text-secondary">
            {i18nService.t('scheduledTasksSearchNoResults')}
          </p>
          <button
            type="button"
            onClick={onClearSearch}
            className="mt-3 text-sm text-primary transition-colors hover:text-primary-hover"
          >
            {i18nService.t('scheduledTasksClearSearch')}
          </button>
        </div>
      ) : (
        <div className={MANAGEMENT_LIST_CONTAINER_CLASS}>
          {visibleTasks.map(task => (
            <TaskCard key={task.id} task={task} onRequestDelete={onRequestDelete} />
          ))}
        </div>
      )}

      <TemplateGallery onCreateFromTemplate={onCreateFromTemplate} />
    </div>
  );
};

export default TaskList;
