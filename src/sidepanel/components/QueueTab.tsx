import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search, Trash2, X } from 'lucide-react';
import type { AccountIntent, AccountRecord, RunnerLiveState } from '../../types/schema';
import type { BridgeResponse, ExtensionMessage } from '../../types/messages';
import { normalizeSearchText } from '../../lib/constants';
import { VirtualAccountList } from './VirtualAccountList';

export interface QueueTabProps {
  accounts: AccountRecord[];
  runner: RunnerLiveState;
  onDispatch: (msg: ExtensionMessage) => Promise<BridgeResponse>;
}

type QueueViewMode = 'queued' | 'history';

function formatRelativeAgo(timestamp?: number): string {
  if (!timestamp) return '';
  const diffSec = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  return `${diffDays}d ago`;
}

export const QueueTab: React.FC<QueueTabProps> = ({ accounts, runner, onDispatch }) => {
  const [viewMode, setViewMode] = useState<QueueViewMode>('queued');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedRaw, setSelectedRaw] = useState<Set<string>>(() => new Set());
  const selectAllRef = useRef<HTMLInputElement | null>(null);

  const queuedAccounts = useMemo(
    () => accounts.filter((a) => a.status === 'queued_unfollow'),
    [accounts],
  );

  const historyAccounts = useMemo(
    () =>
      accounts
        .filter(
          (a) => a.status === 'unfollowed_migrate' || a.status === 'unfollowed_dropped',
        )
        .sort((a, b) => (b.unfollowedAt ?? 0) - (a.unfollowedAt ?? 0)),
    [accounts],
  );

  const queuedUsernamesSet = useMemo(
    () => new Set(queuedAccounts.map((a) => a.username)),
    [queuedAccounts],
  );

  const selectedSet = useMemo(() => {
    const valid = new Set<string>();
    for (const u of selectedRaw) {
      if (queuedUsernamesSet.has(u)) {
        valid.add(u);
      }
    }
    return valid;
  }, [selectedRaw, queuedUsernamesSet]);

  const visibleItems = useMemo(() => {
    const base = viewMode === 'queued' ? queuedAccounts : historyAccounts;
    const normalized = normalizeSearchText(searchQuery).replace(/^@/, '');
    if (!normalized) return base;
    return base.filter(
      (acc) =>
        normalizeSearchText(acc.username).includes(normalized) ||
        normalizeSearchText(acc.displayName).includes(normalized),
    );
  }, [viewMode, queuedAccounts, historyAccounts, searchQuery]);

  const { allVisibleSelected, someVisibleSelected } = useMemo(() => {
    if (viewMode !== 'queued' || visibleItems.length === 0) {
      return { allVisibleSelected: false, someVisibleSelected: false };
    }
    let count = 0;
    for (const item of visibleItems) {
      if (selectedSet.has(item.username)) count += 1;
    }
    return {
      allVisibleSelected: count === visibleItems.length,
      someVisibleSelected: count > 0,
    };
  }, [viewMode, visibleItems, selectedSet]);

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someVisibleSelected && !allVisibleSelected;
    }
  }, [someVisibleSelected, allVisibleSelected]);

  const handleToggleRowSelect = useCallback((username: string) => {
    setSelectedRaw((prev) => {
      const next = new Set(prev);
      if (next.has(username)) {
        next.delete(username);
      } else {
        next.add(username);
      }
      return next;
    });
  }, []);

  const handleToggleSelectVisible = useCallback(() => {
    setSelectedRaw((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const item of visibleItems) {
          next.delete(item.username);
        }
      } else {
        for (const item of visibleItems) {
          next.add(item.username);
        }
      }
      return next;
    });
  }, [allVisibleSelected, visibleItems]);

  const handleRemoveSelected = useCallback(() => {
    const usernames = Array.from(selectedSet);
    if (usernames.length === 0) return;
    void onDispatch({ type: 'UNQUEUE_ACCOUNTS_BULK', usernames });
    setSelectedRaw(new Set());
  }, [selectedSet, onDispatch]);

  const handleClearAllQueued = useCallback(() => {
    const usernames = queuedAccounts.map((a) => a.username);
    if (usernames.length === 0) return;
    void onDispatch({ type: 'UNQUEUE_ACCOUNTS_BULK', usernames });
    setSelectedRaw(new Set());
  }, [queuedAccounts, onDispatch]);

  const handleToggleIntent = useCallback(
    (username: string, nextIntent: AccountIntent) => {
      void onDispatch({ type: 'SET_INTENT_BULK', usernames: [username], intent: nextIntent });
      const target = accounts.find((a) => a.username === username);
      if (
        target &&
        (target.status === 'unfollowed_migrate' || target.status === 'unfollowed_dropped')
      ) {
        void onDispatch({
          type: 'SET_ACCOUNT_STATUS',
          username,
          status: nextIntent === 'migrate' ? 'unfollowed_migrate' : 'unfollowed_dropped',
          recordTimestamp: false,
        });
      }
    },
    [accounts, onDispatch],
  );

  const renderRowAction = useCallback(
    (account: AccountRecord) => {
      if (viewMode === 'queued') {
        return (
          <button
            type="button"
            data-testid={`unqueue-single-btn-${account.username}`}
            onClick={() =>
              void onDispatch({
                type: 'UNQUEUE_ACCOUNTS_BULK',
                usernames: [account.username],
              })
            }
            aria-label={`Remove @${account.username} from queue`}
            title="Remove from Queue"
            className="inline-flex items-center gap-1 rounded-md border border-zinc-200/90 bg-white px-2 py-0.5 text-[10px] font-semibold text-zinc-600 transition-colors hover:border-rose-500/35 hover:bg-rose-500/10 hover:text-rose-600 dark:border-white/[0.1] dark:bg-[#111113] dark:text-zinc-300 dark:hover:text-rose-300"
          >
            <X className="h-3 w-3" />
            Remove
          </button>
        );
      }

      return (
        <span className="tabular-nums text-[10px] text-zinc-400 dark:text-zinc-500">
          {formatRelativeAgo(account.unfollowedAt)}
        </span>
      );
    },
    [viewMode, onDispatch],
  );

  const activeRunnerTarget =
    runner.state !== 'idle' && runner.currentTarget ? runner.currentTarget : undefined;

  return (
    <div data-testid="queue-tab" className="flex min-h-0 flex-1 flex-col">
      {/* Toolbar */}
      <div className="shrink-0 border-b border-zinc-200/80 bg-[#f8f8fa] px-3 py-2 [@media(max-height:520px)]:py-1.5 dark:border-white/[0.08] dark:bg-[#09090b]">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={
                viewMode === 'queued'
                  ? 'Search queued accounts...'
                  : 'Search unfollowed history...'
              }
              aria-label="Search queue"
              data-testid="queue-search-input"
              className="h-8 w-full rounded-lg border border-zinc-200/90 bg-white pl-8 pr-7 text-[12px] text-zinc-900 placeholder:text-zinc-400 focus:border-indigo-500 focus:outline-none [@media(max-height:520px)]:h-7 dark:border-white/[0.08] dark:bg-[#111113] dark:text-zinc-100 dark:placeholder:text-zinc-500 dark:focus:border-indigo-400"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                aria-label="Clear queue search"
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Sub-view pills + bulk queue removal */}
        <div className="mt-2 flex flex-wrap items-center justify-between gap-1.5">
          <div className="flex items-center gap-1">
            <button
              type="button"
              data-testid="queue-view-queued-btn"
              onClick={() => setViewMode('queued')}
              className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[10.5px] font-semibold tabular-nums transition-colors ${
                viewMode === 'queued'
                  ? 'border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-950'
                  : 'border-zinc-200/80 bg-white text-zinc-600 hover:text-zinc-900 dark:border-white/[0.08] dark:bg-[#111113] dark:text-zinc-400 dark:hover:text-zinc-200'
              }`}
            >
              <span>Queued</span>
              <span className="opacity-75">{queuedAccounts.length}</span>
            </button>

            <button
              type="button"
              data-testid="queue-view-history-btn"
              onClick={() => setViewMode('history')}
              className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[10.5px] font-semibold tabular-nums transition-colors ${
                viewMode === 'history'
                  ? 'border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-950'
                  : 'border-zinc-200/80 bg-white text-zinc-600 hover:text-zinc-900 dark:border-white/[0.08] dark:bg-[#111113] dark:text-zinc-400 dark:hover:text-zinc-200'
              }`}
            >
              <span>Unfollowed History</span>
              <span className="opacity-75">{historyAccounts.length}</span>
            </button>
          </div>

          {viewMode === 'queued' && queuedAccounts.length > 0 && (
            <div className="flex items-center gap-1.5">
              <label className="inline-flex cursor-pointer select-none items-center gap-1 text-[10.5px] font-medium text-zinc-600 dark:text-zinc-300">
                <input
                  ref={selectAllRef}
                  type="checkbox"
                  checked={visibleItems.length > 0 && allVisibleSelected}
                  onChange={handleToggleSelectVisible}
                  data-testid="queue-select-visible-checkbox"
                  className="h-3.5 w-3.5 rounded border-zinc-300 text-indigo-600 focus:ring-indigo-500 dark:border-zinc-700 dark:bg-zinc-900"
                />
                <span>Select</span>
              </label>

              {selectedSet.size > 0 ? (
                <button
                  type="button"
                  data-testid="unqueue-selected-btn"
                  onClick={handleRemoveSelected}
                  className="inline-flex items-center gap-1 rounded-md border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 text-[10.5px] font-semibold tabular-nums text-rose-600 hover:bg-rose-500/20 dark:text-rose-300"
                >
                  <Trash2 className="h-3 w-3" />
                  Remove ({selectedSet.size})
                </button>
              ) : (
                <button
                  type="button"
                  data-testid="clear-queue-btn"
                  onClick={handleClearAllQueued}
                  className="rounded-md border border-zinc-200/80 bg-white px-2 py-0.5 text-[10.5px] font-medium text-zinc-600 hover:text-rose-600 dark:border-white/[0.08] dark:bg-[#111113] dark:text-zinc-400 dark:hover:text-rose-300"
                >
                  Clear Queue
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      <VirtualAccountList
        testId="queue-virtual-list"
        items={visibleItems}
        selectable={viewMode === 'queued'}
        selectedSet={selectedSet}
        onToggleSelect={handleToggleRowSelect}
        onToggleIntent={handleToggleIntent}
        intentDisplayMode="queue"
        activeRunnerTarget={viewMode === 'queued' ? activeRunnerTarget : undefined}
        renderRowAction={renderRowAction}
        emptyTitle={
          viewMode === 'queued'
            ? 'Unfollow queue is empty'
            : 'No unfollowed accounts recorded yet'
        }
        emptyDescription={
          viewMode === 'queued'
            ? 'Select accounts in the Following tab and move them to the queue to prune safely.'
            : 'Accounts you unfollow manually or via Safe Auto-Unfollow appear here.'
        }
      />
    </div>
  );
};
