/**
 * Settings form for user-configured media generation providers.
 *
 * The media tools derive their model list entirely from this config, so this
 * form is the only way a user gets image/video generation to work. Entries are
 * filled in by hand (baseUrl / apiKey / modelId); nothing here talks to a
 * LobsterAI server.
 *
 * Saving writes the whole config in one call and the main process re-reads it
 * per request, so edits take effect immediately without an app restart.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';

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

interface EntryEditorProps {
  entry: MediaProviderEntry;
  index: number;
  onChange: (index: number, field: EntryField, value: string) => void;
  onRemove: (index: number) => void;
  onClearApiKey: (index: number) => void;
}

const EntryEditor: React.FC<EntryEditorProps> = ({ entry, index, onChange, onRemove, onClearApiKey }) => (
  <div className="space-y-3 rounded-lg border px-4 py-4 border-border bg-surface/50">
    <div className="flex items-center justify-between">
      <div className="text-xs font-medium text-secondary">
        {entry.displayName || entry.modelId || i18nService.t('mediaProviderUntitled')}
      </div>
      <button
        type="button"
        onClick={() => onRemove(index)}
        className="text-xs text-red-500 hover:underline"
      >
        {i18nService.t('mediaProviderRemove')}
      </button>
    </div>

    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <div>
        <label className="block text-xs font-medium text-foreground mb-1">
          {i18nService.t('mediaProviderDisplayName')}
        </label>
        <input
          type="text"
          value={entry.displayName}
          onChange={(e) => onChange(index, 'displayName', e.target.value)}
          placeholder="DALL·E 3"
          className="w-full rounded-lg border px-3 py-2 text-sm border-border bg-surface"
        />
      </div>
      <div>
        <label className="block text-xs font-medium text-foreground mb-1">
          {i18nService.t('mediaProviderModelId')}
        </label>
        <input
          type="text"
          value={entry.modelId}
          onChange={(e) => onChange(index, 'modelId', e.target.value)}
          placeholder="gpt-image-1"
          className="w-full rounded-lg border px-3 py-2 text-sm border-border bg-surface font-mono"
        />
      </div>
    </div>

    <div>
      <label className="block text-xs font-medium text-foreground mb-1">
        {i18nService.t('mediaProviderBaseUrl')}
      </label>
      <input
        type="text"
        value={entry.baseUrl}
        onChange={(e) => onChange(index, 'baseUrl', e.target.value)}
        placeholder="https://api.openai.com/v1"
        className="w-full rounded-lg border px-3 py-2 text-sm border-border bg-surface font-mono"
      />
    </div>

    <div>
      <div className="flex items-center justify-between mb-1">
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
        onChange={(e) => onChange(index, 'apiKey', e.target.value)}
        autoComplete="off"
        placeholder={entry.apiKeyStored ? i18nService.t('mediaProviderApiKeyKeepPlaceholder') : ''}
        className="w-full rounded-lg border px-3 py-2 text-sm border-border bg-surface font-mono"
      />
      <div className="flex items-center justify-between mt-1">
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
            onClick={() => onClearApiKey(index)}
            className="text-xs text-red-500 hover:underline"
          >
            {i18nService.t('mediaProviderApiKeyClear')}
          </button>
        )}
      </div>
    </div>

    <div>
      <label className="block text-xs font-medium text-foreground mb-1">
        {i18nService.t('mediaProviderCapabilities')}
      </label>
      <input
        type="text"
        value={entry.capabilities ?? ''}
        onChange={(e) => onChange(index, 'capabilities', e.target.value)}
        placeholder={i18nService.t('mediaProviderCapabilitiesPlaceholder')}
        className="w-full rounded-lg border px-3 py-2 text-sm border-border bg-surface"
      />
    </div>
  </div>
);

const MediaProviderSettingsSection: React.FC = () => {
  const [config, setConfig] = useState<MediaProvidersConfig>(EMPTY_MEDIA_PROVIDERS_CONFIG);
  const [activeKind, setActiveKind] = useState<MediaProviderKindType>(MediaProviderKind.Image);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  /**
   * Stable per-row React keys for the active kind. Row identity must not be
   * the array index: removing a row would shift every key below it, and React
   * would then reuse the wrong inputs. Only the active tab is tracked, because
   * a kind switch replaces the whole visible list.
   */
  const rowIdCounterRef = useRef(0);
  const [rowIds, setRowIds] = useState<string[]>([]);

  const makeRowIds = useCallback((count: number): string[] => {
    const result: string[] = [];
    for (let i = 0; i < count; i += 1) {
      rowIdCounterRef.current += 1;
      result.push(`media-row-${rowIdCounterRef.current}`);
    }
    return result;
  }, []);

  const applyConfig = useCallback((next: MediaProvidersConfig, kind: MediaProviderKindType) => {
    setConfig(next);
    setActiveKind(kind);
    setRowIds(makeRowIds(next[kind].length));
  }, [makeRowIds]);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setIsLoading(true);
      setErrorMessage(null);
      try {
        const result = await window.electron.media.getProviders();
        if (cancelled) return;
        if (!result.success) {
          setErrorMessage(result.error || i18nService.t('mediaProviderLoadFailed'));
          return;
        }
        const loaded = normalizeMediaProvidersConfig(result.config) ?? EMPTY_MEDIA_PROVIDERS_CONFIG;
        applyConfig(loaded, MediaProviderKind.Image);
      } catch (error) {
        if (!cancelled) {
          setErrorMessage(error instanceof Error ? error.message : i18nService.t('mediaProviderLoadFailed'));
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [applyConfig]);

  const entries = config[activeKind];

  const updateEntries = useCallback((next: MediaProviderEntry[]) => {
    setConfig(prev => ({ ...prev, [activeKind]: next }));
    setStatusMessage(null);
    setErrorMessage(null);
  }, [activeKind]);

  const handleFieldChange = useCallback((index: number, field: EntryField, value: string) => {
    const next = entries.map((entry, i) => {
      if (i !== index) return entry;
      // Typing a key supersedes a pending clear, otherwise the save would
      // discard the value the user just entered.
      if (field === 'apiKey') {
        return { ...entry, apiKey: value, clearApiKey: false, apiKeyStored: Boolean(value) };
      }
      return { ...entry, [field]: value };
    });
    updateEntries(next);
  }, [entries, updateEntries]);

  const handleClearApiKey = useCallback((index: number) => {
    // A blank key normally means "keep the stored one", so the intent has to be
    // flagged explicitly for the main process to actually remove it.
    const next = entries.map((entry, i) => (
      i === index
        ? { ...entry, apiKey: '', apiKeyStored: false, apiKeyIssue: undefined, clearApiKey: true }
        : entry
    ));
    updateEntries(next);
  }, [entries, updateEntries]);

  const handleAdd = useCallback(() => {
    setRowIds(prev => [...prev, ...makeRowIds(1)]);
    updateEntries([...entries, { ...EMPTY_ENTRY }]);
  }, [entries, makeRowIds, updateEntries]);

  const handleRemove = useCallback((index: number) => {
    setRowIds(prev => prev.filter((_, i) => i !== index));
    updateEntries(entries.filter((_, i) => i !== index));
  }, [entries, updateEntries]);

  const handleKindChange = useCallback((kind: MediaProviderKindType) => {
    setActiveKind(kind);
    setRowIds(makeRowIds(config[kind].length));
    setStatusMessage(null);
    setErrorMessage(null);
  }, [config, makeRowIds]);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    setStatusMessage(null);
    setErrorMessage(null);
    try {
      // Normalize before sending so the UI and the persisted state agree on
      // dropped/blank entries.
      const payload = normalizeMediaProvidersConfig(config) ?? config;
      const result = await window.electron.media.setProviders(payload);
      if (!result.success) {
        setErrorMessage(result.error || i18nService.t('mediaProviderSaveFailed'));
        return;
      }
      // The main process normalizes on write (blank rows are dropped), so the
      // row ids have to be rebuilt to match the persisted list.
      applyConfig(normalizeMediaProvidersConfig(result.config) ?? payload, activeKind);
      setStatusMessage(i18nService.t('mediaProviderSaveSuccess'));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : i18nService.t('mediaProviderSaveFailed'));
    } finally {
      setIsSaving(false);
    }
  }, [activeKind, applyConfig, config]);

  const kindTabs: { key: MediaProviderKindType; label: string }[] = [
    { key: MediaProviderKind.Image, label: i18nService.t('mediaImageModels') },
    { key: MediaProviderKind.Video, label: i18nService.t('mediaVideoModels') },
  ];

  return (
    <div className="space-y-4">
      <div>
        <div className="text-sm font-medium text-foreground">
          {i18nService.t('mediaProviderConfigTitle')}
        </div>
        <div className="text-xs text-secondary mt-1">
          {i18nService.t('mediaProviderConfigDesc')}
        </div>
      </div>

      <div className="flex gap-2">
        {kindTabs.map(tab => (
          <button
            key={tab.key}
            type="button"
            onClick={() => handleKindChange(tab.key)}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
              activeKind === tab.key
                ? 'bg-primary text-white'
                : 'border border-border text-secondary hover:text-foreground'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="text-xs text-secondary">{i18nService.t('mediaLoadingModels')}</div>
      ) : (
        <div className="space-y-3">
          {entries.length === 0 && (
            <div className="rounded-lg border border-dashed px-4 py-6 text-center text-xs text-secondary border-border">
              {i18nService.t('mediaProviderEmpty')}
            </div>
          )}

          {entries.map((entry, index) => (
            <EntryEditor
              key={rowIds[index] ?? `media-row-fallback-${index}`}
              entry={entry}
              index={index}
              onChange={handleFieldChange}
              onRemove={handleRemove}
              onClearApiKey={handleClearApiKey}
            />
          ))}

          <button
            type="button"
            onClick={handleAdd}
            className="rounded-lg border px-3 py-2 text-xs font-medium border-border text-foreground hover:bg-surface"
          >
            {i18nService.t('mediaProviderAdd')}
          </button>
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleSave}
          disabled={isSaving || isLoading}
          className="rounded-lg bg-primary px-4 py-2 text-xs font-medium text-white disabled:opacity-50"
        >
          {isSaving ? i18nService.t('mediaProviderSaving') : i18nService.t('mediaProviderSave')}
        </button>
        {statusMessage && <span className="text-xs text-green-600">{statusMessage}</span>}
        {errorMessage && <span className="text-xs text-red-500">{errorMessage}</span>}
      </div>
    </div>
  );
};

export default MediaProviderSettingsSection;
