import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronUp,
  Download,
  FileJson,
  FileSpreadsheet,
  RotateCcw,
  Share2,
  Trash2,
  Upload,
} from 'lucide-react';
import type {
  AutomationConfig,
  ModeLimitConfig,
  StorageStateV1,
} from '../../types/schema';
import type { BridgeResponse, ExtensionMessage } from '../../types/messages';
import {
  EXTENSION_AUTHOR,
  EXTENSION_AUTHOR_URL,
  EXTENSION_NAME,
} from '../../lib/constants';
import {
  canShareExportNatively,
  serializeAccountsCsv,
  serializeStateJson,
  triggerFileDownload,
  triggerNativeShareExport,
  validateAndNormalizeBackup,
} from '../../lib/exporters';

export interface DataLimitsTabProps {
  state: StorageStateV1;
  onDispatch: (msg: ExtensionMessage) => Promise<BridgeResponse>;
}

function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

const DEFAULT_PRUNE_LIMITS: ModeLimitConfig = { maxPerHour: 15, maxPerDay: 80 };
const DEFAULT_WARMUP_LIMITS: ModeLimitConfig = { maxPerHour: 10, maxPerDay: 35 };
const DEFAULT_AUTOMATION: AutomationConfig = {
  minDelaySec: 28,
  maxDelaySec: 58,
  batchSizeBeforeBreak: 12,
  breakMinMinutes: 5,
  breakMaxMinutes: 8,
  profileFallback: false,
  autoResumeAfterCooldown: true,
};

interface SliderRowProps {
  label: string;
  value: number;
  unit?: string;
  min: number;
  max: number;
  testId: string;
  onChange: (nextValue: number) => void;
}

/**
 * Copies into `form` only the fields whose stored value changed between `prevStored` and
 * `nextStored`, keeping the user's other unsaved edits intact.
 */
function mergeChangedFields<T extends object>(form: T, prevStored: T, nextStored: T): T {
  let out = form;
  for (const key of Object.keys(nextStored) as Array<keyof T>) {
    if (prevStored[key] !== nextStored[key] && out[key] !== nextStored[key]) {
      if (out === form) {
        out = { ...form };
      }
      out[key] = nextStored[key];
    }
  }
  return out;
}

const SliderRow: React.FC<SliderRowProps> = ({
  label,
  value,
  unit = '',
  min,
  max,
  testId,
  onChange,
}) => {
  // Typing "25" into a field with min=10 used to clamp the first keystroke ("2" → 10) and end up
  // as 105; partial values also nudged the paired min/max field. Keep a free-text draft while the
  // field is focused and only clamp + apply it on blur / Enter.
  const [draft, setDraft] = useState(String(value));
  const [isEditing, setIsEditing] = useState(false);

  useEffect(() => {
    if (!isEditing) {
      setDraft(String(value));
    }
  }, [value, isEditing]);

  const commitDraft = (): void => {
    const trimmed = draft.trim();
    const parsed = Number(trimmed);
    if (trimmed !== '' && Number.isFinite(parsed)) {
      const clamped = Math.min(max, Math.max(min, Math.round(parsed)));
      if (clamped !== value) {
        onChange(clamped);
      }
      setDraft(String(clamped));
    } else {
      setDraft(String(value));
    }
  };

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <label htmlFor={testId} className="font-medium text-zinc-700 dark:text-zinc-300">
          {label}
        </label>
        <div className="flex items-center gap-1 tabular-nums">
          <input
            id={testId}
            type="number"
            min={min}
            max={max}
            value={isEditing ? draft : String(value)}
            data-testid={`${testId}-number`}
            onFocus={() => {
              setDraft(String(value));
              setIsEditing(true);
            }}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              commitDraft();
              setIsEditing(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                commitDraft();
                (e.target as HTMLInputElement).blur();
              } else if (e.key === 'Escape') {
                setDraft(String(value));
                setIsEditing(false);
                (e.target as HTMLInputElement).blur();
              }
            }}
            className="h-6 w-14 rounded border border-zinc-200/90 bg-white px-1.5 text-right text-[11px] font-semibold text-zinc-900 focus:border-indigo-500 focus:outline-none dark:border-white/[0.1] dark:bg-zinc-900 dark:text-zinc-100"
          />
          {unit && <span className="text-[10.5px] text-zinc-400">{unit}</span>}
        </div>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        data-testid={testId}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
        className="macos-slider w-full"
      />
    </div>
  );
};

export const DataLimitsTab: React.FC<DataLimitsTabProps> = ({ state, onDispatch }) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const resetTimerRef = useRef<number | null>(null);

  // Export & Import feedback states
  const [exportFeedback, setExportFeedback] = useState<string | null>(null);
  const [importMode, setImportMode] = useState<'merge' | 'replace'>('merge');
  const [showPasteBox, setShowPasteBox] = useState(false);
  const [rawJsonText, setRawJsonText] = useState('');
  const [importFeedback, setImportFeedback] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);

  // Safety limits editable state
  const [pruneLimits, setPruneLimits] = useState<ModeLimitConfig>(
    state.safety.limits.old_prune,
  );
  const [warmupLimits, setWarmupLimits] = useState<ModeLimitConfig>(
    state.safety.limits.new_warmup,
  );
  const [autoCfg, setAutoCfg] = useState<AutomationConfig>(state.safety.automationConfig);
  const [limitsSavedToast, setLimitsSavedToast] = useState<string | null>(null);

  // Double-click Reset confirmation within 4 seconds
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [resetFeedback, setResetFeedback] = useState<string | null>(null);
  const resetArmedAtRef = useRef(0);

  // Replace-mode imports wipe local accounts, so they wait for an explicit confirmation.
  const [pendingReplace, setPendingReplace] = useState<{
    data: StorageStateV1;
    sourceLabel: string;
    incomingCount: number;
  } | null>(null);

  // Re-sync the editable form only when the STORED values actually change. Keying this on the
  // object references re-ran it on every state push (the runner patches state every second),
  // which silently reverted unsaved edits before the user could press Save.
  const storedSafetyKey = JSON.stringify([
    state.safety.limits.old_prune,
    state.safety.limits.new_warmup,
    state.safety.automationConfig,
  ]);
  const prevStoredSafetyRef = useRef({
    prune: state.safety.limits.old_prune,
    warmup: state.safety.limits.new_warmup,
    auto: state.safety.automationConfig,
  });
  useEffect(() => {
    const prev = prevStoredSafetyRef.current;
    const next = {
      prune: state.safety.limits.old_prune,
      warmup: state.safety.limits.new_warmup,
      auto: state.safety.automationConfig,
    };
    prevStoredSafetyRef.current = next;
    setPruneLimits((form) => mergeChangedFields(form, prev.prune, next.prune));
    setWarmupLimits((form) => mergeChangedFields(form, prev.warmup, next.warmup));
    setAutoCfg((form) => mergeChangedFields(form, prev.auto, next.auto));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedSafetyKey]);

  useEffect(() => {
    return () => {
      if (resetTimerRef.current !== null) {
        window.clearTimeout(resetTimerRef.current);
      }
    };
  }, []);

  const commitSafetyPatch = async (
    nextPrune: ModeLimitConfig,
    nextWarmup: ModeLimitConfig,
    nextAuto: AutomationConfig,
    toastLabel = 'Safety limits saved',
  ): Promise<void> => {
    const res = await onDispatch({
      type: 'UPDATE_SAFETY_LIMITS',
      limits: {
        old_prune: nextPrune,
        new_warmup: nextWarmup,
      },
      automationConfig: nextAuto,
    });
    if (res.ok) {
      setLimitsSavedToast(toastLabel);
      window.setTimeout(() => {
        setLimitsSavedToast((curr) => (curr === toastLabel ? null : curr));
      }, 2800);
    }
  };

  const handleExportJson = (): void => {
    const content = serializeStateJson(state);
    const byteLength = new TextEncoder().encode(content).byteLength;
    const accountCount = Object.keys(state.accounts).length;
    triggerFileDownload('chaos-tamer-backup.json', content, 'application/json');
    setExportFeedback(
      `Exported chaos-tamer-backup.json · ${accountCount} accounts (${formatByteSize(byteLength)})`,
    );
  };

  const handleExportCsv = (): void => {
    const records = Object.values(state.accounts);
    const content = serializeAccountsCsv(records);
    const byteLength = new TextEncoder().encode(content).byteLength;
    triggerFileDownload('chaos-tamer-accounts.csv', content, 'text/csv;charset=utf-8');
    setExportFeedback(
      `Exported chaos-tamer-accounts.csv · ${records.length} rows (${formatByteSize(byteLength)})`,
    );
  };

  const handleShareJson = (): void => {
    const content = serializeStateJson(state);
    const byteLength = new TextEncoder().encode(content).byteLength;
    const accountCount = Object.keys(state.accounts).length;
    if (triggerNativeShareExport('chaos-tamer-backup.json', content, 'application/json')) {
      setExportFeedback(
        `Sharing chaos-tamer-backup.json · ${accountCount} accounts (${formatByteSize(byteLength)})`,
      );
    }
  };

  const processRawImportString = async (text: string, sourceLabel: string): Promise<void> => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      setImportFeedback({
        ok: false,
        message: `Invalid JSON syntax in ${sourceLabel}.`,
      });
      return;
    }

    const validation = validateAndNormalizeBackup(parsed);
    if (!validation.valid) {
      setImportFeedback({
        ok: false,
        message: validation.error,
      });
      return;
    }

    const incomingCount = Object.keys(validation.state.accounts).length;
    if (importMode === 'replace') {
      setImportFeedback(null);
      setPendingReplace({ data: validation.state, sourceLabel, incomingCount });
      return;
    }
    await dispatchImport(validation.state, 'merge', sourceLabel, incomingCount);
  };

  const dispatchImport = async (
    data: StorageStateV1,
    mode: 'merge' | 'replace',
    sourceLabel: string,
    incomingCount: number,
  ): Promise<void> => {
    const response = await onDispatch({
      type: 'IMPORT_BACKUP',
      data,
      mode,
    });

    if (!response.ok) {
      setImportFeedback({
        ok: false,
        message: response.error || 'Failed to import backup.',
      });
      return;
    }

    const finalCount = response.importedCount ?? incomingCount;
    setImportFeedback({
      ok: true,
      message:
        mode === 'merge'
          ? `Merged ${finalCount} accounts from ${sourceLabel}.`
          : `Replaced state with ${finalCount} accounts from ${sourceLabel} (rolling rate-limit history kept).`,
    });
    setRawJsonText('');
  };

  const handleConfirmReplace = async (): Promise<void> => {
    const pending = pendingReplace;
    setPendingReplace(null);
    if (!pending) return;
    await dispatchImport(pending.data, 'replace', pending.sourceLabel, pending.incomingCount);
  };

  const handleFileChange = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ): Promise<void> => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    try {
      const content = await file.text();
      await processRawImportString(content, file.name);
    } catch {
      setImportFeedback({
        ok: false,
        message: `Could not read file "${file.name}".`,
      });
    }
  };

  const handlePasteImportSubmit = async (): Promise<void> => {
    if (!rawJsonText.trim()) {
      setImportFeedback({
        ok: false,
        message: 'Paste valid Chaos Tamer backup JSON first.',
      });
      return;
    }
    await processRawImportString(rawJsonText, 'pasted JSON');
  };

  const handlePruneChange = (patch: Partial<ModeLimitConfig>): void => {
    const merged: ModeLimitConfig = { ...pruneLimits, ...patch };
    if (merged.maxPerHour > merged.maxPerDay) {
      if (patch.maxPerHour !== undefined) {
        merged.maxPerDay = merged.maxPerHour;
      } else {
        merged.maxPerHour = merged.maxPerDay;
      }
    }
    setPruneLimits(merged);
  };

  const handleWarmupChange = (patch: Partial<ModeLimitConfig>): void => {
    const merged: ModeLimitConfig = { ...warmupLimits, ...patch };
    if (merged.maxPerHour > merged.maxPerDay) {
      if (patch.maxPerHour !== undefined) {
        merged.maxPerDay = merged.maxPerHour;
      } else {
        merged.maxPerHour = merged.maxPerDay;
      }
    }
    setWarmupLimits(merged);
  };

  const handleAutoNumericChange = (patch: Partial<AutomationConfig>): void => {
    const merged: AutomationConfig = { ...autoCfg, ...patch };
    if (merged.minDelaySec > merged.maxDelaySec) {
      if (patch.minDelaySec !== undefined) {
        merged.maxDelaySec = merged.minDelaySec;
      } else {
        merged.minDelaySec = merged.maxDelaySec;
      }
    }
    if (merged.breakMinMinutes > merged.breakMaxMinutes) {
      if (patch.breakMinMinutes !== undefined) {
        merged.breakMaxMinutes = merged.breakMinMinutes;
      } else {
        merged.breakMinMinutes = merged.breakMaxMinutes;
      }
    }
    setAutoCfg(merged);
  };

  const handleToggleBooleanOption = (
    key: 'profileFallback' | 'autoResumeAfterCooldown',
  ): void => {
    const nextValue = !autoCfg[key];
    setAutoCfg((prev) => ({ ...prev, [key]: nextValue }));
    void onDispatch({
      type: 'UPDATE_SAFETY_LIMITS',
      automationConfig: { [key]: nextValue },
    }).then((res) => {
      if (res.ok) {
        const toastLabel = 'Updated automation setting';
        setLimitsSavedToast(toastLabel);
        window.setTimeout(() => {
          setLimitsSavedToast((curr) => (curr === toastLabel ? null : curr));
        }, 2800);
      }
    });
  };

  const handleRestoreDefaults = (): void => {
    setPruneLimits(DEFAULT_PRUNE_LIMITS);
    setWarmupLimits(DEFAULT_WARMUP_LIMITS);
    setAutoCfg(DEFAULT_AUTOMATION);
    void commitSafetyPatch(
      DEFAULT_PRUNE_LIMITS,
      DEFAULT_WARMUP_LIMITS,
      DEFAULT_AUTOMATION,
      'Restored recommended safety defaults',
    );
  };

  const handleResetClick = async (): Promise<void> => {
    if (confirmingReset && Date.now() - resetArmedAtRef.current < 700) {
      // Second click of a double-click: not a deliberate confirmation.
      return;
    }
    if (!confirmingReset) {
      resetArmedAtRef.current = Date.now();
      setConfirmingReset(true);
      setResetFeedback(null);
      if (resetTimerRef.current !== null) {
        window.clearTimeout(resetTimerRef.current);
      }
      resetTimerRef.current = window.setTimeout(() => {
        setConfirmingReset(false);
        resetTimerRef.current = null;
      }, 4000);
      return;
    }

    if (resetTimerRef.current !== null) {
      window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }
    setConfirmingReset(false);

    const res = await onDispatch({ type: 'RESET_ALL_DATA' });
    if (res.ok) {
      setResetFeedback('All stored accounts and rolling timestamps have been reset.');
    }
  };

  return (
    <div
      data-testid="data-limits-tab"
      className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3"
    >
      {/* 1. Portable Backup & CSV Export Card */}
      <section className="rounded-xl border border-zinc-200/80 bg-white p-3 shadow-sm dark:border-white/[0.08] dark:bg-[#111113]">
        <div className="flex items-center justify-between">
          <h2 className="text-[12px] font-semibold text-zinc-900 dark:text-zinc-100">
            Backup & Cross-Profile Portability
          </h2>
          <Download className="h-3.5 w-3.5 text-zinc-400" />
        </div>
        <p className="mt-1 text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
          Export your full state on your old Instagram account, then import it on your new
          session or Chrome profile.
        </p>

        <div className="mt-2.5 grid grid-cols-2 gap-2">
          <button
            type="button"
            data-testid="export-json-btn"
            onClick={handleExportJson}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-zinc-900 px-2.5 py-2 text-[11.5px] font-semibold text-white transition-colors hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-950 dark:hover:bg-white"
          >
            <FileJson className="h-3.5 w-3.5" />
            Export JSON Backup
          </button>

          <button
            type="button"
            data-testid="export-csv-btn"
            onClick={handleExportCsv}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-zinc-200/90 bg-zinc-50 px-2.5 py-2 text-[11.5px] font-semibold text-zinc-800 transition-colors hover:bg-zinc-100 dark:border-white/[0.1] dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
          >
            <FileSpreadsheet className="h-3.5 w-3.5" />
            Export CSV
          </button>
        </div>

        {canShareExportNatively() && (
          <button
            type="button"
            data-testid="share-json-btn"
            onClick={handleShareJson}
            className="mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-indigo-500/35 bg-indigo-500/10 px-2.5 py-1.5 text-[11px] font-semibold text-indigo-700 transition-colors hover:bg-indigo-500/20 dark:text-indigo-300"
          >
            <Share2 className="h-3.5 w-3.5" />
            Share Backup via Quick Share / Apps
          </button>
        )}

        {exportFeedback && (
          <div
            data-testid="export-feedback"
            className="mt-2 flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1.5 text-[11px] font-medium tabular-nums text-emerald-700 dark:text-emerald-300"
          >
            <Check className="h-3.5 w-3.5 shrink-0" />
            <span>{exportFeedback}</span>
          </div>
        )}

        {/* Import JSON Backup */}
        <div className="mt-3 border-t border-zinc-200/70 pt-3 dark:border-white/[0.06]">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11.5px] font-semibold text-zinc-800 dark:text-zinc-200">
              Import JSON Backup
            </span>

            <div
              role="radiogroup"
              aria-label="Import backup mode"
              className="flex items-center gap-3 text-[11px]"
            >
              <label className="inline-flex cursor-pointer items-center gap-1 font-medium text-zinc-700 dark:text-zinc-300">
                <input
                  type="radio"
                  name="import-mode"
                  value="merge"
                  checked={importMode === 'merge'}
                  onChange={() => setImportMode('merge')}
                  data-testid="import-mode-merge"
                  className="h-3 w-3 text-indigo-600 focus:ring-indigo-500"
                />
                Merge
              </label>
              <label className="inline-flex cursor-pointer items-center gap-1 font-medium text-zinc-700 dark:text-zinc-300">
                <input
                  type="radio"
                  name="import-mode"
                  value="replace"
                  checked={importMode === 'replace'}
                  onChange={() => setImportMode('replace')}
                  data-testid="import-mode-replace"
                  className="h-3 w-3 text-indigo-600 focus:ring-indigo-500"
                />
                Replace
              </label>
            </div>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            onChange={(e) => void handleFileChange(e)}
            data-testid="import-file-input"
            className="hidden"
          />

          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              data-testid="import-file-btn"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-zinc-200/90 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-zinc-800 transition-colors hover:bg-zinc-100 dark:border-white/[0.1] dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
            >
              <Upload className="h-3.5 w-3.5" />
              Choose .json Backup
            </button>

            <button
              type="button"
              data-testid="toggle-paste-json-btn"
              onClick={() => setShowPasteBox((prev) => !prev)}
              className="inline-flex items-center gap-1 rounded-lg border border-zinc-200/90 bg-zinc-50 px-2.5 py-1.5 text-[11px] font-medium text-zinc-600 hover:text-zinc-900 dark:border-white/[0.08] dark:bg-zinc-900/70 dark:text-zinc-400 dark:hover:text-zinc-100"
            >
              Paste JSON
              {showPasteBox ? (
                <ChevronUp className="h-3 w-3" />
              ) : (
                <ChevronDown className="h-3 w-3" />
              )}
            </button>
          </div>

          {showPasteBox && (
            <div className="mt-2 space-y-2">
              <textarea
                rows={4}
                value={rawJsonText}
                onChange={(e) => setRawJsonText(e.target.value)}
                placeholder='{"schemaVersion": 1, "accounts": { ... }}'
                data-testid="import-json-textarea"
                className="w-full rounded-lg border border-zinc-200/90 bg-zinc-50 p-2 font-mono text-[10.5px] text-zinc-800 focus:border-indigo-500 focus:outline-none dark:border-white/[0.1] dark:bg-zinc-950 dark:text-zinc-200"
              />
              <button
                type="button"
                data-testid="import-paste-submit-btn"
                onClick={() => void handlePasteImportSubmit()}
                className="w-full rounded-lg bg-indigo-600 px-2.5 py-1.5 text-[11px] font-semibold text-white transition-colors hover:bg-indigo-500"
              >
                Validate & Import JSON
              </button>
            </div>
          )}

          {pendingReplace && (
            <div
              role="alertdialog"
              aria-label="Confirm replace import"
              data-testid="import-replace-confirm"
              className="mt-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-[11px] text-amber-800 dark:text-amber-200"
            >
              <p className="font-semibold">
                Replace all {Object.keys(state.accounts).length} local accounts with{' '}
                {pendingReplace.incomingCount} from {pendingReplace.sourceLabel}?
              </p>
              <p className="mt-0.5 leading-relaxed">
                Local intents, queue and migration progress will be overwritten. Your rolling
                1h/24h rate-limit history is kept.
              </p>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  data-testid="import-replace-confirm-btn"
                  onClick={() => void handleConfirmReplace()}
                  className="flex-1 rounded-md bg-amber-600 px-2 py-1 text-[11px] font-semibold text-white hover:bg-amber-500"
                >
                  Replace
                </button>
                <button
                  type="button"
                  data-testid="import-replace-cancel-btn"
                  onClick={() => setPendingReplace(null)}
                  className="flex-1 rounded-md border border-zinc-300/80 bg-white px-2 py-1 text-[11px] font-semibold text-zinc-700 hover:bg-zinc-100 dark:border-white/[0.12] dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {importFeedback && (
            <div
              data-testid="import-feedback"
              className={`mt-2 rounded-lg border px-2.5 py-1.5 text-[11px] font-medium ${
                importFeedback.ok
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                  : 'border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300'
              }`}
            >
              {importFeedback.message}
            </div>
          )}
        </div>
      </section>

      {/* 2. Editable Safety Limits & Humanization Sliders */}
      <section className="rounded-xl border border-zinc-200/80 bg-white p-3 shadow-sm dark:border-white/[0.08] dark:bg-[#111113]">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="text-[12px] font-semibold text-zinc-900 dark:text-zinc-100">
              Rolling Rate Limits & Humanization
            </h2>
            <p className="text-[10.5px] text-zinc-500 dark:text-zinc-400">
              Conservative bounds protect both old and fresh Instagram accounts.
            </p>
          </div>
          <button
            type="button"
            onClick={handleRestoreDefaults}
            data-testid="restore-default-limits-btn"
            title="Restore conservative default limits"
            className="inline-flex items-center gap-1 rounded-md border border-zinc-200/80 bg-zinc-50 px-2 py-1 text-[10px] font-medium text-zinc-600 hover:text-zinc-900 dark:border-white/[0.08] dark:bg-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200"
          >
            <RotateCcw className="h-3 w-3" />
            Defaults
          </button>
        </div>

        {/* Old Page: Prune Caps */}
        <div className="mt-3 space-y-2 rounded-lg border border-zinc-200/70 bg-zinc-50/70 p-2.5 dark:border-white/[0.06] dark:bg-zinc-950/60">
          <div className="text-[11px] font-semibold text-zinc-800 dark:text-zinc-200">
            Old Page: Prune (Unfollow Caps)
          </div>
          <SliderRow
            label="Max Unfollows / Hour"
            value={pruneLimits.maxPerHour}
            min={1}
            max={60}
            testId="limit-prune-hour"
            onChange={(val) => handlePruneChange({ maxPerHour: val })}
          />
          <SliderRow
            label="Max Unfollows / 24 Hours"
            value={pruneLimits.maxPerDay}
            min={5}
            max={250}
            testId="limit-prune-day"
            onChange={(val) => handlePruneChange({ maxPerDay: val })}
          />
        </div>

        {/* New Page: Follow Caps */}
        <div className="mt-2.5 space-y-2 rounded-lg border border-zinc-200/70 bg-zinc-50/70 p-2.5 dark:border-white/[0.06] dark:bg-zinc-950/60">
          <div className="text-[11px] font-semibold text-zinc-800 dark:text-zinc-200">
            New Page: Follow (Warmup Caps)
          </div>
          <SliderRow
            label="Max Follows / Hour"
            value={warmupLimits.maxPerHour}
            min={1}
            max={45}
            testId="limit-warmup-hour"
            onChange={(val) => handleWarmupChange({ maxPerHour: val })}
          />
          <SliderRow
            label="Max Follows / 24 Hours"
            value={warmupLimits.maxPerDay}
            min={5}
            max={160}
            testId="limit-warmup-day"
            onChange={(val) => handleWarmupChange({ maxPerDay: val })}
          />
        </div>

        {/* Gaussian Delay & Micro-Break */}
        <div className="mt-2.5 space-y-2 rounded-lg border border-zinc-200/70 bg-zinc-50/70 p-2.5 dark:border-white/[0.06] dark:bg-zinc-950/60">
          <div className="text-[11px] font-semibold text-zinc-800 dark:text-zinc-200">
            Box-Muller Gaussian Delay & Micro-Breaks
          </div>
          <SliderRow
            label="Min Inter-Action Delay"
            value={autoCfg.minDelaySec}
            unit="s"
            min={10}
            max={120}
            testId="limit-min-delay"
            onChange={(val) => handleAutoNumericChange({ minDelaySec: val })}
          />
          <SliderRow
            label="Max Inter-Action Delay"
            value={autoCfg.maxDelaySec}
            unit="s"
            min={15}
            max={180}
            testId="limit-max-delay"
            onChange={(val) => handleAutoNumericChange({ maxDelaySec: val })}
          />
          <SliderRow
            label="Batch Size Before Break"
            value={autoCfg.batchSizeBeforeBreak}
            min={3}
            max={40}
            testId="limit-batch-size"
            onChange={(val) => handleAutoNumericChange({ batchSizeBeforeBreak: val })}
          />
          <SliderRow
            label="Micro-Break Minimum"
            value={autoCfg.breakMinMinutes}
            unit="m"
            min={1}
            max={25}
            testId="limit-break-min"
            onChange={(val) => handleAutoNumericChange({ breakMinMinutes: val })}
          />
          <SliderRow
            label="Micro-Break Maximum"
            value={autoCfg.breakMaxMinutes}
            unit="m"
            min={2}
            max={35}
            testId="limit-break-max"
            onChange={(val) => handleAutoNumericChange({ breakMaxMinutes: val })}
          />
        </div>

        {/* Automation Switches */}
        <div className="mt-2.5 space-y-2">
          <div className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200/70 px-2.5 py-2 dark:border-white/[0.06]">
            <div>
              <div className="text-[11px] font-semibold text-zinc-800 dark:text-zinc-200">
                Profile Fallback Mode
              </div>
              <div className="text-[10px] text-zinc-500 dark:text-zinc-400">
                Navigate directly to profile page if Following modal row isn&apos;t mounted.
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-label="Profile Fallback Mode"
              aria-checked={autoCfg.profileFallback}
              data-testid="toggle-profile-fallback"
              onClick={() => handleToggleBooleanOption('profileFallback')}
              className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
                autoCfg.profileFallback
                  ? 'bg-indigo-600'
                  : 'bg-zinc-300 dark:bg-zinc-700'
              }`}
            >
              <span
                className={`block h-4 w-4 translate-y-0.5 rounded-full bg-white shadow transition-transform ${
                  autoCfg.profileFallback ? 'translate-x-4' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>

          <div className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200/70 px-2.5 py-2 dark:border-white/[0.06]">
            <div>
              <div className="text-[11px] font-semibold text-zinc-800 dark:text-zinc-200">
                Auto-Resume After Cooldown
              </div>
              <div className="text-[10px] text-zinc-500 dark:text-zinc-400">
                Automatically continue queued unfollows when rolling cap window frees a slot.
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-label="Auto-Resume After Cooldown"
              aria-checked={autoCfg.autoResumeAfterCooldown}
              data-testid="toggle-auto-resume"
              onClick={() => handleToggleBooleanOption('autoResumeAfterCooldown')}
              className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
                autoCfg.autoResumeAfterCooldown
                  ? 'bg-indigo-600'
                  : 'bg-zinc-300 dark:bg-zinc-700'
              }`}
            >
              <span
                className={`block h-4 w-4 translate-y-0.5 rounded-full bg-white shadow transition-transform ${
                  autoCfg.autoResumeAfterCooldown ? 'translate-x-4' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>
        </div>

        <div className="mt-3 flex items-center justify-between gap-2">
          <button
            type="button"
            data-testid="save-safety-limits-btn"
            onClick={() =>
              void commitSafetyPatch(pruneLimits, warmupLimits, autoCfg, 'Safety limits saved')
            }
            className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-zinc-900 px-3 py-2 text-[11.5px] font-semibold text-white transition-colors hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-950 dark:hover:bg-white"
          >
            <Check className="h-3.5 w-3.5" />
            Save Safety Limits
          </button>

          {limitsSavedToast && (
            <span
              data-testid="limits-saved-toast"
              className="shrink-0 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[10.5px] font-semibold text-emerald-700 dark:text-emerald-300"
            >
              {limitsSavedToast}
            </span>
          )}
        </div>
      </section>

      {/* 3. Danger Zone Card */}
      <section className="rounded-xl border border-rose-500/25 bg-white p-3 shadow-sm dark:border-rose-500/20 dark:bg-[#111113]">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="text-[12px] font-semibold text-rose-600 dark:text-rose-400">
              Danger Zone
            </h2>
            <p className="text-[10.5px] text-zinc-500 dark:text-zinc-400">
              Permanently clear stored accounts, queues, and rolling rate-limit history.
            </p>
          </div>

          <button
            type="button"
            data-testid="reset-all-data-btn"
            onClick={() => void handleResetClick()}
            className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] font-semibold transition-colors ${
              confirmingReset
                ? 'border-rose-600 bg-rose-600 text-white hover:bg-rose-500'
                : 'border-rose-500/35 bg-rose-500/10 text-rose-600 hover:bg-rose-500/20 dark:text-rose-300'
            }`}
          >
            <Trash2 className="h-3.5 w-3.5" />
            {confirmingReset ? 'Click again to confirm reset' : 'Reset All Data'}
          </button>
        </div>

        {resetFeedback && (
          <p
            data-testid="reset-feedback"
            className="mt-2 text-[10.5px] font-medium text-zinc-600 dark:text-zinc-300"
          >
            {resetFeedback}
          </p>
        )}
      </section>

      {/* 4. Dedicated Creator / About Card */}
      <section
        data-testid="creator-about-card"
        className="rounded-xl border border-zinc-200/80 bg-white p-3 shadow-sm dark:border-white/[0.08] dark:bg-[#111113]"
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] border border-white/15 bg-zinc-950 shadow-sm">
              <img
                src="/icons/logo-white.png"
                alt="Chaos Tamer logo"
                className="h-[18px] w-[18px] select-none object-contain"
                draggable={false}
              />
            </div>

            <div className="min-w-0">
              <div className="truncate text-[12px] font-semibold text-zinc-900 dark:text-zinc-100">
                {EXTENSION_NAME} v1.1 · Crafted by {EXTENSION_AUTHOR}
              </div>
              <div className="text-[10.5px] text-zinc-500 dark:text-zinc-400">
                Safe Instagram Following Pruner &amp; Migration Hub
              </div>
            </div>
          </div>

          <a
            href={EXTENSION_AUTHOR_URL}
            target="_blank"
            rel="noreferrer"
            data-testid="about-author-link"
            className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-zinc-200/90 bg-zinc-50 px-2.5 py-1 text-[10.5px] font-semibold text-zinc-800 transition-colors hover:bg-zinc-100 dark:border-white/[0.1] dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            Made by {EXTENSION_AUTHOR}
            <ArrowUpRight className="h-3 w-3" />
          </a>
        </div>
      </section>
    </div>
  );
};
