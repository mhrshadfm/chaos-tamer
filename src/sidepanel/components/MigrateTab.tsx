import React, { useCallback, useEffect, useRef } from 'react';
import { Check, ExternalLink, Search, X } from 'lucide-react';
import type { AccountRecord } from '../../types/schema';
import type { BridgeResponse, ExtensionMessage } from '../../types/messages';
import { VirtualAccountList } from './VirtualAccountList';

export type MigrateFilterId = 'ready' | 'done' | 'all';

export interface MigrateTabProps {
  items: AccountRecord[];
  filterCounts: Record<MigrateFilterId, number>;
  activeFilter: MigrateFilterId;
  onFilterChange: (filter: MigrateFilterId) => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  includeFollowingInMigrate: boolean;
  activeVisitedUsername?: string;
  scrollToUsername: string | null;
  scrollSignal: number;
  onOpenNextProfile: () => void;
  onDispatch: (msg: ExtensionMessage) => Promise<BridgeResponse>;
}

const MIGRATE_FILTERS: ReadonlyArray<{ id: MigrateFilterId; label: string }> = [
  { id: 'ready', label: 'Ready to Follow' },
  { id: 'done', label: 'Followed / Requested' },
  { id: 'all', label: 'All' },
];

const STEP_THROTTLE_MS = 600;

/**
 * Only real text-entry / form controls keep Space for themselves. Buttons and links used to be
 * excluded WITHOUT preventDefault, so after clicking a row action with the mouse, Space re-clicked
 * that button (duplicate background tab, or toggling "Done" back off) or scrolled the list.
 */
function isTextEntryElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    return true;
  }
  return target.isContentEditable;
}

export const MigrateTab: React.FC<MigrateTabProps> = ({
  items,
  filterCounts,
  activeFilter,
  onFilterChange,
  searchQuery,
  onSearchChange,
  includeFollowingInMigrate,
  activeVisitedUsername,
  scrollToUsername,
  scrollSignal,
  onOpenNextProfile,
  onDispatch,
}) => {
  // Spacebar quick-stepper when not typing in a text field
  const lastStepAtRef = useRef(0);
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.code !== 'Space' && event.key !== ' ') {
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
        return;
      }
      if (isTextEntryElement(event.target) || isTextEntryElement(document.activeElement)) {
        return;
      }
      event.preventDefault();
      // Holding Space auto-repeats keydown ~30×/s, which fired a burst of Instagram navigations.
      if (event.repeat) {
        return;
      }
      const now = Date.now();
      if (now - lastStepAtRef.current < STEP_THROTTLE_MS) {
        return;
      }
      lastStepAtRef.current = now;
      onOpenNextProfile();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onOpenNextProfile]);

  const handleOpenSingleTab = useCallback(
    (account: AccountRecord) => {
      void onDispatch({ type: 'OPEN_PROFILE_TAB', username: account.username });
    },
    [onDispatch],
  );

  const handleOpenBackgroundTab = useCallback(
    (username: string) => {
      void onDispatch({ type: 'OPEN_PROFILE_TAB', username, background: true });
    },
    [onDispatch],
  );

  const handleToggleDone = useCallback(
    (account: AccountRecord) => {
      const isDone =
        account.status === 'migrated_following' || account.status === 'migrated_requested';

      void onDispatch({
        type: 'SET_ACCOUNT_STATUS',
        username: account.username,
        status: isDone ? 'unfollowed_migrate' : 'migrated_following',
        recordTimestamp: !isDone,
      });
    },
    [onDispatch],
  );

  const renderRowAction = useCallback(
    (account: AccountRecord) => {
      const isDone =
        account.status === 'migrated_following' || account.status === 'migrated_requested';

      return (
        <div className="flex items-center gap-1">
          <button
            type="button"
            data-testid={`open-bg-tab-btn-${account.username}`}
            onClick={() => handleOpenBackgroundTab(account.username)}
            aria-label={`Open @${account.username} in a background tab`}
            title="Open in background tab"
            className="flex h-6 w-6 items-center justify-center rounded-md border border-zinc-200/80 bg-white text-zinc-500 transition-colors hover:border-zinc-300 hover:text-zinc-900 dark:border-white/[0.08] dark:bg-[#111113] dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
          >
            <ExternalLink className="h-3 w-3" />
          </button>

          <button
            type="button"
            data-testid={`migrate-done-btn-${account.username}`}
            onClick={() => handleToggleDone(account)}
            className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10.5px] font-semibold transition-colors ${
              isDone
                ? 'border-emerald-500/35 bg-emerald-500/15 text-emerald-700 hover:bg-emerald-500/25 dark:text-emerald-300'
                : 'border-zinc-200/90 bg-white text-zinc-700 hover:border-emerald-500/40 hover:bg-emerald-500/10 hover:text-emerald-700 dark:border-white/[0.1] dark:bg-[#111113] dark:text-zinc-200 dark:hover:text-emerald-300'
            }`}
          >
            <Check className="h-3 w-3" />
            Done
          </button>
        </div>
      );
    },
    [handleOpenBackgroundTab, handleToggleDone],
  );

  return (
    <div data-testid="migrate-tab" className="flex min-h-0 flex-1 flex-col">
      {/* Toolbar */}
      <div className="shrink-0 border-b border-zinc-200/80 bg-[#f8f8fa] px-3 py-2 [@media(max-height:520px)]:py-1.5 dark:border-white/[0.08] dark:bg-[#09090b]">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search migration accounts..."
            aria-label="Search migration accounts"
            data-testid="migrate-search-input"
            className="h-8 w-full rounded-lg border border-zinc-200/90 bg-white pl-8 pr-7 text-[12px] text-zinc-900 placeholder:text-zinc-400 focus:border-indigo-500 focus:outline-none [@media(max-height:520px)]:h-7 dark:border-white/[0.08] dark:bg-[#111113] dark:text-zinc-100 dark:placeholder:text-zinc-500 dark:focus:border-indigo-400"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => onSearchChange('')}
              aria-label="Clear migration search"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1 overflow-x-auto">
            {MIGRATE_FILTERS.map((f) => {
              const active = activeFilter === f.id;
              return (
                <button
                  key={f.id}
                  type="button"
                  data-testid={`migrate-filter-${f.id}`}
                  onClick={() => onFilterChange(f.id)}
                  className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-semibold tabular-nums transition-colors ${
                    active
                      ? 'border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-950'
                      : 'border-zinc-200/80 bg-white text-zinc-600 hover:text-zinc-900 dark:border-white/[0.08] dark:bg-[#111113] dark:text-zinc-400 dark:hover:text-zinc-200'
                  }`}
                >
                  <span>{f.label}</span>
                  <span className="opacity-75">{filterCounts[f.id]}</span>
                </button>
              );
            })}
          </div>

          <label className="inline-flex cursor-pointer select-none items-center gap-1.5 text-[10.5px] font-medium text-zinc-600 dark:text-zinc-400">
            <input
              type="checkbox"
              checked={includeFollowingInMigrate}
              onChange={(e) =>
                void onDispatch({
                  type: 'SET_INCLUDE_FOLLOWING_MIGRATE',
                  include: e.target.checked,
                })
              }
              data-testid="include-following-migrate-checkbox"
              className="h-3.5 w-3.5 rounded border-zinc-300 text-indigo-600 focus:ring-indigo-500 dark:border-zinc-700 dark:bg-zinc-900"
            />
            <span>Include still-following</span>
          </label>
        </div>
      </div>

      <VirtualAccountList
        testId="migrate-virtual-list"
        items={items}
        intentDisplayMode="hidden"
        activeVisitedUsername={activeVisitedUsername}
        scrollToUsername={scrollToUsername}
        scrollSignal={scrollSignal}
        onRowClick={handleOpenSingleTab}
        renderRowAction={renderRowAction}
        emptyTitle={
          activeFilter === 'ready'
            ? 'No accounts waiting to be followed'
            : 'No migration accounts match this view'
        }
        emptyDescription={
          activeFilter === 'ready'
            ? 'Unfollow accounts marked with Migrate intent—or enable "Include still-following" above—to step through them on your new page.'
            : 'Switch filter pills or clear your search query.'
        }
      />
    </div>
  );
};
