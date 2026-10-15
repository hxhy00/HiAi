/**
 * Settings form for user-configured media generation providers.
 *
 * The media tools derive their model list entirely from this config, so this
 * form is the only way a user gets image/video generation to work. Entries are
 * filled in by hand (baseUrl / apiKey / modelId); nothing here talks to a
 * LobsterAI server.
 *
 * Image and video models are two blocks stacked vertically and always both
 * visible — never a two-way toggle — so the user can see the whole picture at
 * once. Inside a block the layout mirrors the text-model settings page: model
 * list on the left, the selected model's settings on the right.
 *
 * Saving writes the whole config in one call and the main process re-reads it
 * per request, so edits take effect immediately without an app restart. Because
 * the IPC is a single whole-config write, saving one block also persists the
 * other block's pending edits; each block still owns its own button and status.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  EMPTY_MEDIA_PROVIDERS_CONFIG,
  type MediaProviderEntry,
  MediaProviderKind,
  type MediaProviderKind as MediaProviderKindType,
  type MediaProvidersConfig,
  normalizeMediaProvidersConfig,
} from '../../../shared/cowork/mediaProviders';
import { i18nService } from '../../services/i18n';

const EMPTY_ENTRY: MediaProviderEntry = {
  key: '',
  displayName: '',
  baseUrl: '',
  apiKey: '',
  modelId: '',
};

type EntryField = keyof MediaProviderEntry;

/** Per-block save feedback, kept separate so saving one block does not clear the other. */
interface BlockStatus {
  isSaving: boolean;
  statusMessage: string | null;
  errorMessage: string | null;
}

const IDLE_BLOCK_STATUS: BlockStatus = { isSaving: false, statusMessage: null, errorMessage: null };

interface EntryFormProps {
  entry: MediaProviderEntry;
  onChange: (field: EntryField, value: string) => void;
  onClearApiKey: () => void;
}

/**
 * Settings form for one model. Never renders a secret: the stored key is
 * reported as a boolean, and leaving the field blank means "keep what is on
 * disk" (see `clearApiKey` on the shared entry contract).
 */
const EntryForm: React.FC<EntryFormProps> = ({ entry, onChange, onClearApiKey }) => (
  <div className="space-y-3">
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <div>
        <label className="mb-1 block text-xs font-medium text-foreground">
          {i18nService.t('mediaProviderDisplayName')}
        </label>
        <input
          type="text"
          value={entry.displayName}
          onChange={e => onChange('displayName', e.target.value)}
          placeholder="DALL·E 3"
          className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
        />
      </div>
      <div>
        <label className="mb-1 block text-xs font-medium text-foreground">
          {i18nService.t('mediaProviderModelId')}
        </label>
        <input
          type="text"
          value={entry.modelId}
          onChange={e => onChange('modelId', e.target.value)}
          placeholder="gpt-image-1"
          className="w-full rounded-lg border border-border bg-surface px-3 py-2 font-mono text-sm"
        />
      </div>
    </div>

    <div>
      <label className="mb-1 block text-xs font-medium text-foreground">
        {i18nService.t('mediaProviderBaseUrl')}
      </label>
      <input
        type="text"
        value={entry.baseUrl}
        onChange={e => onChange('baseUrl', e.target.value)}
        placeholder="https://api.openai.com/v1"
        className="w-full rounded-lg border border-border bg-surface px-3 py-2 font-mono text-sm"
      />
    </div>

    <div>
      <div className="mb-1 flex items-center justify-between">
        <label className="block text-xs font-medium text-foreground">
          {i18nService.t('mediaProviderApiKey')}
        </label>
        {entry.apiKeyStored && (
          <span className="text-xs text-green-600">
            {i18nService.t('mediaProviderApiKeyStored')}
          </span>
        )}
      </div>
      <input
        type="password"
        value={entry.apiKey}
        onChange={e => onChange('apiKey', e.target.value)}
        autoComplete="off"
        placeholder={entry.apiKeyStored ? i18nService.t('mediaProviderApiKeyKeepPlaceholder') : ''}
        className="w-full rounded-lg border border-border bg-surface px-3 py-2 font-mono text-sm"
      />
      <div className="mt-1 flex items-center justify-between">
        <div className="text-xs text-secondary">
          {entry.apiKeyIssue === 'undecryptable'
            ? i18nService.t('mediaProviderApiKeyUndecryptable')
            : entry.apiKeyIssue === 'encryption-unavailable'
              ? i18nService.t('mediaProviderApiKeyNoKeyring')
              : i18nService.t('mediaProviderApiKeyHint')}
        </div>
        {entry.apiKeyStored && (
          <button
            type="button"
            onClick={onClearApiKey}
            className="text-xs text-red-500 hover:underline"
          >
            {i18nService.t('mediaProviderApiKeyClear')}
          </button>
        )}
      </div>
    </div>

    <div>
      <label className="mb-1 block text-xs font-medium text-foreground">
        {i18nService.t('mediaProviderCapabilities')}
      </label>
      <input
        type="text"
        value={entry.capabilities ?? ''}
        onChange={e => onChange('capabilities', e.target.value)}
        placeholder={i18nService.t('mediaProviderCapabilitiesPlaceholder')}
        className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
      />
    </div>
  </div>
);

interface MediaProviderKindPanelProps {
  title: string;
  entries: MediaProviderEntry[];
  /** Stable row ids, positionally aligned with `entries`. */
  rowIds: string[];
  selectedRowId: string | null;
  searchQuery: string;
  status: BlockStatus;
  /** Set while the config is loading, so both blocks render inert. */
  isLoading: boolean;
  onSearchChange: (value: string) => void;
  onSelect: (rowId: string) => void;
  onFieldChange: (rowId: string, field: EntryField, value: string) => void;
  onClearApiKey: (rowId: string) => void;
  onRemove: (rowId: string) => void;
  onAdd: () => void;
  onSave: () => void;
}

/**
 * One kind's block: a searchable model list on the left, the selected model's
 * settings on the right, and its own save button underneath. Image and video
 * render through this same component — only the title and the data differ.
 */
const MediaProviderKindPanel: React.FC<MediaProviderKindPanelProps> = ({
  title,
  entries,
  rowIds,
  selectedRowId,
  searchQuery,
  status,
  isLoading,
  onSearchChange,
  onSelect,
  onFieldChange,
  onClearApiKey,
  onRemove,
  onAdd,
  onSave,
}) => {
  const normalizedQuery = searchQuery.trim().toLowerCase();
  // Filtering only narrows what the list shows: the selection lives outside the
  // filter, so searching never swaps the form out from under the user.
  const visibleRowIds = useMemo(() => rowIds.filter((_, index) => {
    if (!normalizedQuery) return true;
    const entry = entries[index];
    if (!entry) return false;
    return entry.displayName.toLowerCase().includes(normalizedQuery)
      || entry.modelId.toLowerCase().includes(normalizedQuery);
  }), [entries, normalizedQuery, rowIds]);

  const selectedIndex = selectedRowId === null ? -1 : rowIds.indexOf(selectedRowId);
  const selectedEntry = selectedIndex >= 0 ? entries[selectedIndex] : undefined;

  return (
    <section className="rounded-xl border border-border bg-surface">
      <header className="border-b border-border px-4 py-3 text-sm font-medium text-foreground">
        {title}
      </header>

      {/* A fixed minimum keeps the two blocks visually balanced when one kind has
          no models yet; each list scrolls inside its own column instead. */}
      <div className="flex min-h-[420px] flex-col md:flex-row">
        <div className="flex w-full flex-col border-b border-border md:w-2/5 md:border-b-0 md:border-r">
          <div className="border-b border-border p-3">
            <input
              type="text"
              value={searchQuery}
              onChange={e => onSearchChange(e.target.value)}
              placeholder={i18nService.t('mediaProviderSearchPlaceholder')}
              className="w-full rounded-lg border border-border bg-surface px-3 py-1.5 text-xs"
            />
          </div>

          <div className="max-h-[240px] flex-1 overflow-y-auto p-2 md:max-h-none">
            {visibleRowIds.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-secondary">
                {entries.length === 0
                  ? i18nService.t('mediaProviderEmpty')
                  : i18nService.t('mediaNoModels')}
              </div>
            ) : (
              <div className="space-y-1">
                {visibleRowIds.map(rowId => {
                  const index = rowIds.indexOf(rowId);
                  const entry = entries[index];
                  if (!entry) return null;
                  const isSelected = rowId === selectedRowId;
                  return (
                    <button
                      key={rowId}
                      type="button"
                      onClick={() => onSelect(rowId)}
                      className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors ${
                        isSelected ? 'bg-primary/10' : 'hover:bg-surface-raised'
                      }`}
                    >
                      <span className="min-w-0 flex-1">
                        <span className={`block truncate text-xs font-medium ${isSelected ? 'text-primary' : 'text-foreground'}`}>
                          {entry.displayName || entry.modelId || i18nService.t('mediaProviderUntitled')}
                        </span>
                        {entry.modelId && (
                          <span className="mt-0.5 block truncate font-mono text-[11px] text-secondary">
                            {entry.modelId}
                          </span>
                        )}
                      </span>
                      <span
                        role="button"
                        tabIndex={0}
                        onClick={e => {
                          e.stopPropagation();
                          onRemove(rowId);
                        }}
                        onKeyDown={e => {
                          if (e.key !== 'Enter' && e.key !== ' ') return;
                          e.preventDefault();
                          e.stopPropagation();
                          onRemove(rowId);
                        }}
                        className="shrink-0 rounded px-1.5 py-0.5 text-xs text-secondary transition-colors hover:bg-surface-raised hover:text-red-500"
                      >
                        {i18nService.t('mediaProviderRemove')}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="border-t border-border p-3">
            <button
              type="button"
              onClick={onAdd}
              disabled={isLoading}
              className="w-full rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-surface-raised disabled:opacity-50"
            >
              {i18nService.t('mediaProviderAdd')}
            </button>
          </div>
        </div>

        <div className="flex-1 p-4">
          {selectedEntry && (
            <EntryForm
              entry={selectedEntry}
              onChange={(field, value) => onFieldChange(selectedRowId as string, field, value)}
              onClearApiKey={() => onClearApiKey(selectedRowId as string)}
            />
          )}
          {!selectedEntry && (
            <div className="flex h-full items-center justify-center py-10 text-xs text-secondary">
              {i18nService.t('mediaProviderSelectHint')}
            </div>
          )}
        </div>
      </div>

      <footer className="flex items-center gap-3 border-t border-border px-4 py-3">
        <button
          type="button"
          onClick={onSave}
          disabled={status.isSaving || isLoading}
          className="rounded-lg bg-primary px-4 py-2 text-xs font-medium text-white disabled:opacity-50"
        >
          {status.isSaving ? i18nService.t('mediaProviderSaving') : i18nService.t('mediaProviderSave')}
        </button>
        {status.statusMessage && <span className="text-xs text-green-600">{status.statusMessage}</span>}
        {status.errorMessage && <span className="text-xs text-red-500">{status.errorMessage}</span>}
      </footer>
    </section>
  );
};

const MediaProviderSettingsSection: React.FC = () => {
  const [config, setConfig] = useState<MediaProvidersConfig>(EMPTY_MEDIA_PROVIDERS_CONFIG);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchQueries, setSearchQueries] = useState<Record<MediaProviderKindType, string>>({
    [MediaProviderKind.Image]: '',
    [MediaProviderKind.Video]: '',
  });
  const [blockStatus, setBlockStatus] = useState<Record<MediaProviderKindType, BlockStatus>>({
    [MediaProviderKind.Image]: IDLE_BLOCK_STATUS,
    [MediaProviderKind.Video]: IDLE_BLOCK_STATUS,
  });

  /**
   * Stable per-row React keys, tracked per kind. Row identity must not be the
   * array index: removing a row would shift every key below it and React would
   * reuse the wrong inputs. Each kind keeps its own list because both blocks are
   * mounted at once, so a kind switch no longer replaces the visible list.
   */
  const rowIdCounterRef = useRef(0);
  const [rowIds, setRowIds] = useState<Record<MediaProviderKindType, string[]>>({
    [MediaProviderKind.Image]: [],
    [MediaProviderKind.Video]: [],
  });
  const [selectedRowIds, setSelectedRowIds] = useState<Record<MediaProviderKindType, string | null>>({
    [MediaProviderKind.Image]: null,
    [MediaProviderKind.Video]: null,
  });

  const makeRowId = useCallback((): string => {
    rowIdCounterRef.current += 1;
    return `media-row-${rowIdCounterRef.current}`;
  }, []);

  const makeRowIds = useCallback((count: number): string[] => {
    const result: string[] = [];
    for (let i = 0; i < count; i += 1) result.push(makeRowId());
    return result;
  }, [makeRowId]);

  /**
   * Rebuilds row ids after the persisted list changed, keeping the selection if
   * possible. The selection is read through a functional update so this stays
   * free of `selectedRowIds` as a dependency — otherwise picking a different
   * model would rebuild this callback and re-trigger the load effect.
   */
  const adoptConfig = useCallback((next: MediaProvidersConfig) => {
    const rebuilt: Record<MediaProviderKindType, string[]> = {
      [MediaProviderKind.Image]: makeRowIds(next[MediaProviderKind.Image].length),
      [MediaProviderKind.Video]: makeRowIds(next[MediaProviderKind.Video].length),
    };
    setConfig(next);
    setRowIds(rebuilt);
    setSelectedRowIds(current => ({
      [MediaProviderKind.Image]: current[MediaProviderKind.Image]
        && rebuilt[MediaProviderKind.Image].includes(current[MediaProviderKind.Image] as string)
        ? current[MediaProviderKind.Image]
        : rebuilt[MediaProviderKind.Image][0] ?? null,
      [MediaProviderKind.Video]: current[MediaProviderKind.Video]
        && rebuilt[MediaProviderKind.Video].includes(current[MediaProviderKind.Video] as string)
        ? current[MediaProviderKind.Video]
        : rebuilt[MediaProviderKind.Video][0] ?? null,
    }));
  }, [makeRowIds]);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setIsLoading(true);
      setLoadError(null);
      try {
        const result = await window.electron.media.getProviders();
        if (cancelled) return;
        if (!result.success) {
          setLoadError(result.error || i18nService.t('mediaProviderLoadFailed'));
          return;
        }
        adoptConfig(normalizeMediaProvidersConfig(result.config) ?? EMPTY_MEDIA_PROVIDERS_CONFIG);
      } catch (error) {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : i18nService.t('mediaProviderLoadFailed'));
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [adoptConfig]);

  const patchKindStatus = useCallback((kind: MediaProviderKindType, patch: Partial<BlockStatus>) => {
    setBlockStatus(prev => ({ ...prev, [kind]: { ...prev[kind], ...patch } }));
  }, []);

  const updateEntries = useCallback((kind: MediaProviderKindType, next: MediaProviderEntry[]) => {
    setConfig(prev => ({ ...prev, [kind]: next }));
    // Editing invalidates this block's previous outcome, but must leave the other
    // block's status alone.
    patchKindStatus(kind, { statusMessage: null, errorMessage: null });
  }, [patchKindStatus]);

  const handleFieldChange = useCallback((
    kind: MediaProviderKindType,
    rowId: string,
    field: EntryField,
    value: string,
  ) => {
    const entries = config[kind];
    const index = rowIds[kind].indexOf(rowId);
    if (index < 0) return;
    const next = entries.map((entry, i) => {
      if (i !== index) return entry;
      // Typing a key supersedes a pending clear, otherwise the save would
      // discard the value the user just entered.
      if (field === 'apiKey') {
        return { ...entry, apiKey: value, clearApiKey: false, apiKeyStored: Boolean(value) };
      }
      return { ...entry, [field]: value };
    });
    updateEntries(kind, next);
  }, [config, rowIds, updateEntries]);

  const handleClearApiKey = useCallback((kind: MediaProviderKindType, rowId: string) => {
    const entries = config[kind];
    const index = rowIds[kind].indexOf(rowId);
    if (index < 0) return;
    // A blank key normally means "keep the stored one", so the intent has to be
    // flagged explicitly for the main process to actually remove it.
    const next = entries.map((entry, i) => (
      i === index
        ? { ...entry, apiKey: '', apiKeyStored: false, apiKeyIssue: undefined, clearApiKey: true }
        : entry
    ));
    updateEntries(kind, next);
  }, [config, rowIds, updateEntries]);

  const handleAdd = useCallback((kind: MediaProviderKindType) => {
    const newRowId = makeRowId();
    setRowIds(prev => ({ ...prev, [kind]: [...prev[kind], newRowId] }));
    updateEntries(kind, [...config[kind], { ...EMPTY_ENTRY }]);
    // A newly added row starts blank (no modelId), so select it and let the
    // right pane show the empty form instead of leaving the old selection up.
    setSelectedRowIds(prev => ({ ...prev, [kind]: newRowId }));
  }, [config, makeRowId, updateEntries]);

  const handleRemove = useCallback((kind: MediaProviderKindType, rowId: string) => {
    const index = rowIds[kind].indexOf(rowId);
    if (index < 0) return;
    const nextRowIds = rowIds[kind].filter((_, i) => i !== index);
    setRowIds(prev => ({ ...prev, [kind]: nextRowIds }));
    updateEntries(kind, config[kind].filter((_, i) => i !== index));
    setSelectedRowIds(prev => {
      if (prev[kind] !== rowId) return prev;
      // Hand the selection to the neighbour: prefer the row that moved up into
      // this slot, otherwise the one before it when the last row was removed.
      return { ...prev, [kind]: nextRowIds[Math.min(index, nextRowIds.length - 1)] ?? null };
    });
  }, [config, rowIds, updateEntries]);

  const handleSave = useCallback(async (kind: MediaProviderKindType) => {
    patchKindStatus(kind, { isSaving: true, statusMessage: null, errorMessage: null });
    try {
      // Normalize before sending so the UI and the persisted state agree on
      // dropped/blank entries.
      const payload = normalizeMediaProvidersConfig(config) ?? config;
      const result = await window.electron.media.setProviders(payload);
      if (!result.success) {
        patchKindStatus(kind, { errorMessage: result.error || i18nService.t('mediaProviderSaveFailed') });
        return;
      }
      // The main process normalizes on write (blank rows are dropped), so the
      // row ids have to be rebuilt to match the persisted list.
      adoptConfig(normalizeMediaProvidersConfig(result.config) ?? payload);
      patchKindStatus(kind, { statusMessage: i18nService.t('mediaProviderSaveSuccess') });
    } catch (error) {
      patchKindStatus(kind, {
        errorMessage: error instanceof Error ? error.message : i18nService.t('mediaProviderSaveFailed'),
      });
    } finally {
      patchKindStatus(kind, { isSaving: false });
    }
  }, [adoptConfig, config, patchKindStatus]);

  const blocks: Array<{ kind: MediaProviderKindType; title: string }> = [
    { kind: MediaProviderKind.Image, title: i18nService.t('mediaImageModelsSection') },
    { kind: MediaProviderKind.Video, title: i18nService.t('mediaVideoModelsSection') },
  ];

  return (
    <div className="space-y-4">
      <div>
        <div className="text-sm font-medium text-foreground">
          {i18nService.t('mediaProviderConfigTitle')}
        </div>
        <div className="mt-1 text-xs text-secondary">
          {i18nService.t('mediaProviderConfigDesc')}
        </div>
      </div>

      {loadError && <div className="text-xs text-red-500">{loadError}</div>}

      {blocks.map(({ kind, title }) => (
        <MediaProviderKindPanel
          key={kind}
          title={title}
          entries={config[kind]}
          rowIds={rowIds[kind]}
          selectedRowId={selectedRowIds[kind]}
          searchQuery={searchQueries[kind]}
          status={blockStatus[kind]}
          isLoading={isLoading}
          onSearchChange={value => setSearchQueries(prev => ({ ...prev, [kind]: value }))}
          onSelect={rowId => setSelectedRowIds(prev => ({ ...prev, [kind]: rowId }))}
          onFieldChange={(rowId, field, value) => handleFieldChange(kind, rowId, field, value)}
          onClearApiKey={rowId => handleClearApiKey(kind, rowId)}
          onRemove={rowId => handleRemove(kind, rowId)}
          onAdd={() => handleAdd(kind)}
          onSave={() => void handleSave(kind)}
        />
      ))}
    </div>
  );
};

export default MediaProviderSettingsSection;