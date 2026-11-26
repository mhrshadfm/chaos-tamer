import React, { useEffect, useRef } from 'react';
import { Search, X } from 'lucide-react';
import type { AccountIntent } from '../../types/schema';

export type FollowingFilterId = 'all' | 'following' | 'migrate' | 'drop' | 'unfollowed';

export interface BulkToolbarProps {
  searchQuery: string;
  onSearchChange: (value: string) => void;
  activeFilter: FollowingFilterId;
  onFilterChange: (filter: FollowingFilterId) => void;
  filterCounts: Record<FollowingFilterId, number>;
  visibleCount: number;
  selectedCount: number;
  allVisibleSelected: boolean;
  someVisibleSelected: boolean;
  onToggleSelectVisible: () => void;
  onClearSelection: () => void;
  onBulkSetIntent: (intent: AccountIntent) => void;
  onBulkQueueSelected: () => void;
}

const FILTER_DEFS: ReadonlyArray<{ id: FollowingFilterId; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'following', label: 'Following' },
  { id: 'migrate', label: 'Migrate Intent' },
  { id: 'drop', label: 'Drop Intent' },
  { id: 'unfollowed', label: 'Unfollowed' },
];

export const BulkToolbar: React.FC<BulkToolbarProps> = ({
  searchQuery,
  onSearchChange,
  activeFilter,
  onFilterChange,
  filterCounts,
  visibleCount,
  selectedCount,
  allVisibleSelected,
  someVisibleSelected,
  onToggleSelectVisible,
  onClearSelection,
  onBulkSetIntent,
  onBulkQueueSelected,
}) => {
  const checkboxRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (checkboxRef.current) {
      checkboxRef.current.indeterminate = someVisibleSelected && !allVisibleSelected;
    }
  }, [someVisibleSelected, allVisibleSelected]);

  return (
    <div className="shrink-0 border-b border-zinc-200/80 bg-[#f8f8fa] px-3 py-2 [@media(max-height:520px)]:py-1.5 dark:border-white/[0.08] dark:bg-[#09090b]">
      {/* Search Bar */}
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search @username or display name..."
          aria-label="Filter accounts by username or display name"
          data-testid="following-search-input"
          className="h-8 w-full rounded-lg border border-zinc-200/90 bg-white pl-8 pr-7 text-[12px] text-zinc-900 placeholder:text-zinc-400 focus:border-indigo-500 focus:outline-none [@media(max-height:520px)]:h-7 dark:border-white/[0.08] dark:bg-[#111113] dark:text-zinc-100 dark:placeholder:text-zinc-500 dark:focus:border-indigo-400"
        />
        {searchQuery && (
          <button
            type="button"
            onClick={() => onSearchChange('')}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* Filter Pills */}
      <div
        role="tablist"
        aria-label="Account status and intent filters"
        className="mt-2 flex items-center gap-1 overflow-x-auto pb-0.5 [@media(max-height:520px)]:mt-1.5"
      >
        {FILTER_DEFS.map((filter) => {
          const active = activeFilter === filter.id;
          return (
            <button
              key={filter.id}
              type="button"
              role="tab"
              aria-selected={active}
              data-testid={`following-filter-${filter.id}`}
              onClick={() => onFilterChange(filter.id)}
              className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-medium tabular-nums transition-colors ${
                active
                  ? 'border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-950'
                  : 'border-zinc-200/80 bg-white text-zinc-600 hover:border-zinc-300 hover:text-zinc-900 dark:border-white/[0.08] dark:bg-[#111113] dark:text-zinc-400 dark:hover:text-zinc-200'
              }`}
            >
              <span>{filter.label}</span>
              <span className="opacity-75">{filterCounts[filter.id]}</span>
            </button>
          );
        })}
      </div>

      {/* Bulk Selection & Actions */}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-1.5 border-t border-zinc-200/70 pt-2 [@media(max-height:520px)]:mt-1.5 [@media(max-height:520px)]:pt-1.5 dark:border-white/[0.06]">
        <div className="flex items-center gap-2">
          <label className="inline-flex cursor-pointer select-none items-center gap-1.5 text-[11px] font-medium text-zinc-700 dark:text-zinc-300">
            <input
              ref={checkboxRef}
              type="checkbox"
              checked={visibleCount > 0 && allVisibleSelected}
              disabled={visibleCount === 0}
              onChange={onToggleSelectVisible}
              data-testid="select-visible-checkbox"
              className="h-3.5 w-3.5 rounded border-zinc-300 text-indigo-600 focus:ring-indigo-500 dark:border-zinc-700 dark:bg-zinc-900"
            />
            <span>Select Visible</span>
          </label>

          {selectedCount > 0 && (
            <span
              data-testid="selected-count-badge"
              className="inline-flex items-center gap-1 rounded-md bg-indigo-500/15 px-1.5 py-0.5 text-[10.5px] font-semibold tabular-nums text-indigo-700 dark:text-indigo-300"
            >
              {selectedCount} selected
              <button
                type="button"
                onClick={onClearSelection}
                aria-label="Clear selected accounts"
                className="ml-0.5 rounded hover:text-indigo-950 dark:hover:text-white"
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </span>
          )}
        </div>

        {selectedCount === 0 && (
          <span className="text-[10px] text-zinc-400 [@media(min-height:521px)]:hidden dark:text-zinc-500">
            Select rows for bulk actions
          </span>
        )}

        <div
          className={
            selectedCount === 0
              ? 'hidden flex-wrap items-center gap-1 [@media(min-height:521px)]:flex'
              : 'flex flex-wrap items-center gap-1'
          }
        >
          <button
            type="button"
            data-testid="bulk-intent-migrate-btn"
            disabled={selectedCount === 0}
            onClick={() => onBulkSetIntent('migrate')}
            title="Mark selected accounts to keep for your new page"
            className="rounded-md border border-indigo-500/30 bg-indigo-500/10 px-2 py-1 text-[10.5px] font-semibold text-indigo-700 transition-colors hover:bg-indigo-500/20 disabled:cursor-not-allowed disabled:opacity-40 [@media(max-height:520px)]:px-1.5 [@media(max-height:520px)]:py-0.5 dark:text-indigo-300"
          >
            Keep for New Page
          </button>

          <button
            type="button"
            data-testid="bulk-intent-drop-btn"
            disabled={selectedCount === 0}
            onClick={() => onBulkSetIntent('drop')}
            title="Mark selected accounts to drop permanently"
            className="rounded-md border border-zinc-300/80 bg-white px-2 py-1 text-[10.5px] font-semibold text-zinc-700 transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 [@media(max-height:520px)]:px-1.5 [@media(max-height:520px)]:py-0.5 dark:border-white/[0.1] dark:bg-[#111113] dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            Drop Forever
          </button>

          <button
            type="button"
            data-testid="bulk-queue-btn"
            disabled={selectedCount === 0}
            onClick={onBulkQueueSelected}
            title="Move selected accounts into the Safe Auto-Unfollow Queue"
            className="rounded-md bg-zinc-900 px-2 py-1 text-[10.5px] font-semibold text-white transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40 [@media(max-height:520px)]:px-1.5 [@media(max-height:520px)]:py-0.5 dark:bg-zinc-100 dark:text-zinc-950 dark:hover:bg-white"
          >
            Move Selected to Unfollow Queue
          </button>
        </div>
      </div>
    </div>
  );
};
