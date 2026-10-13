/**
 * Tracks which media provider target owns an in-flight task.
 *
 * `main.ts` receives `action=status` with only a task id, but async providers
 * (MiniMax video) need the original credentials and endpoint to poll upstream.
 * The mapping is persisted so a task created before an app restart can still
 * be polled afterwards.
 */
import type { SqliteStore } from '../../sqliteStore';
import type { MediaProviderTarget } from './types';

export const MEDIA_TASK_TARGETS_STORE_KEY = 'mediaTaskTargets';

interface MediaTaskTargetRecord extends MediaProviderTarget {
  /** Epoch ms, used to prune tasks that can no longer be relevant. */
  createdAt: number;
}

type MediaTaskTargetMap = Record<string, MediaTaskTargetRecord>;

/** Tasks older than this are dropped: MiniMax jobs never outlive ~1 day. */
const TASK_TARGET_TTL_MS = 24 * 60 * 60 * 1000;

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const readMap = (store: SqliteStore): MediaTaskTargetMap => {
  try {
    const raw = store.get<unknown>(MEDIA_TASK_TARGETS_STORE_KEY);
    return isRecord(raw) ? raw as MediaTaskTargetMap : {};
  } catch (error) {
    console.warn('[MediaProvider] failed to read media task targets:', error);
    return {};
  }
};

const writeMap = (store: SqliteStore, map: MediaTaskTargetMap): void => {
  try {
    store.set(MEDIA_TASK_TARGETS_STORE_KEY, map);
  } catch (error) {
    // Losing the mapping only affects post-restart polling of this task, so a
    // write failure must not fail the generation call itself.
    console.warn('[MediaProvider] failed to persist media task target:', error);
  }
};

export const rememberMediaTaskTarget = (
  store: SqliteStore,
  taskId: string,
  target: MediaProviderTarget,
): void => {
  if (!taskId) return;

  const now = Date.now();
  const map = readMap(store);
  const pruned: MediaTaskTargetMap = {};
  for (const [id, record] of Object.entries(map)) {
    if (isRecord(record) && typeof record.createdAt === 'number' && now - record.createdAt < TASK_TARGET_TTL_MS) {
      pruned[id] = record;
    }
  }
  pruned[taskId] = { ...target, createdAt: now };
  writeMap(store, pruned);
};

export const resolveMediaTaskTarget = (
  store: SqliteStore,
  taskId: string,
): MediaProviderTarget | undefined => {
  if (!taskId) return undefined;

  const record = readMap(store)[taskId];
  if (!isRecord(record)) return undefined;
  if (typeof record.createdAt !== 'number' || Date.now() - record.createdAt >= TASK_TARGET_TTL_MS) {
    return undefined;
  }

  const { createdAt: _createdAt, ...target } = record;
  return target as MediaProviderTarget;
};

export const forgetMediaTaskTarget = (store: SqliteStore, taskId: string): void => {
  if (!taskId) return;

  const map = readMap(store);
  if (!(taskId in map)) return;
  delete map[taskId];
  writeMap(store, map);
};
