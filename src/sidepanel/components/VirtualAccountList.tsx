import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BadgeCheck } from 'lucide-react';
import type { AccountIntent, AccountRecord, AccountStatus } from '../../types/schema';

const ROW_HEIGHT = 56;
const OVERSCAN = 8;

export interface VirtualAccountListProps {
  items: AccountRecord[];
  selectable?: boolean;
  selectedSet?: ReadonlySet<string>;
  onToggleSelect?: (username: string) => void;
  onToggleIntent?: (username: string, nextIntent: AccountIntent) => void;
  intentDisplayMode?: 'compact' | 'queue' | 'hidden';
  activeVisitedUsername?: string;
  activeRunnerTarget?: string;
  scrollToUsername?: string | null;
  scrollSignal?: number;
  onRowClick?: (account: AccountRecord) => void;
  renderRowAction?: (account: AccountRecord) => React.ReactNode;
  emptyTitle: string;
  emptyDescription?: string;
  testId?: string;
}

function getInitials(account: AccountRecord): string {
  const source = (account.displayName || account.username).trim();
  const clean = source.replace(/[^a-zA-Z0-9\u0600-\u06FF ]/g, '').trim();
  if (!clean) {
    return account.username.slice(0, 2).toUpperCase();
  }
  const parts = clean.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0][0] ?? ''}${parts[1][0] ?? ''}`.toUpperCase();
  }
  return clean.slice(0, 2).toUpperCase();
}

function getStatusPill(status: AccountStatus): { label: string; classes: string } {
  switch (status) {
    case 'following':
      return {
        label: 'Following',
        classes:
          'border-zinc-200/90 bg-zinc-100 text-zinc-600 dark:border-white/[0.08] dark:bg-zinc-800/80 dark:text-zinc-300',
      };
    case 'queued_unfollow':
      return {
        label: 'Queued',
        classes:
          'border-amber-500/30 bg-amber-500/[0.12] text-amber-700 dark:text-amber-300',
      };
    case 'unfollowed_migrate':
      return {
        label: 'Ready',
        classes:
          'border-indigo-500/30 bg-indigo-500/[0.12] text-indigo-700 dark:text-indigo-300',
      };
    case 'unfollowed_dropped':
      return {
        label: 'Dropped',
        classes:
          'border-zinc-300/70 bg-zinc-200/50 text-zinc-500 dark:border-white/[0.06] dark:bg-zinc-900 dark:text-zinc-500',
      };
    case 'migrated_following':
      return {
        label: 'Followed',
        classes:
          'border-emerald-500/30 bg-emerald-500/[0.12] text-emerald-700 dark:text-emerald-300',
      };
    case 'migrated_requested':
      return {
        label: 'Requested',
        classes:
          'border-sky-500/30 bg-sky-500/[0.12] text-sky-700 dark:text-sky-300',
      };
  }
}

interface AccountAvatarProps {
  account: AccountRecord;
}

const AccountAvatar: React.FC<AccountAvatarProps> = React.memo(({ account }) => {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [account.avatarUrl]);

  if (!account.avatarUrl || failed) {
    return (
      <div
        aria-hidden="true"
        className="flex h-8 w-8 shrink-0 select-none items-center justify-center rounded-full border border-zinc-200/80 bg-zinc-200/70 text-[10.5px] font-semibold text-zinc-700 dark:border-white/[0.1] dark:bg-zinc-800 dark:text-zinc-200"
      >
        {getInitials(account)}
      </div>
    );
  }

  return (
    <img
      src={account.avatarUrl}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
      className="h-8 w-8 shrink-0 rounded-full border border-zinc-200/80 bg-zinc-100 object-cover dark:border-white/[0.1] dark:bg-zinc-800"
    />
  );
});

AccountAvatar.displayName = 'AccountAvatar';

export const VirtualAccountList: React.FC<VirtualAccountListProps> = ({
  items,
  selectable = false,
  selectedSet,
  onToggleSelect,
  onToggleIntent,
  intentDisplayMode = 'compact',
  activeVisitedUsername,
  activeRunnerTarget,
  scrollToUsername,
  scrollSignal,
  onRowClick,
  renderRowAction,
  emptyTitle,
  emptyDescription,
  testId = 'virtual-account-list',
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(440);

  // Callback ref: the scroll container unmounts while the list is empty (empty-state view) and a
  // NEW node mounts when items come back. A one-shot effect kept observing the detached node and
  // kept the old scrollTop, rendering a blank list. Re-attach and re-sync on every new node.
  const setContainerNode = useCallback((node: HTMLDivElement | null) => {
    resizeObserverRef.current?.disconnect();
    resizeObserverRef.current = null;
    containerRef.current = node;
    if (!node) {
      return;
    }
    setScrollTop(node.scrollTop);
    const updateHeight = (): void => {
      if (node.clientHeight > 0) {
        setViewportHeight(node.clientHeight);
      }
    };
    updateHeight();
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => {
        updateHeight();
      });
      observer.observe(node);
      resizeObserverRef.current = observer;
    }
  }, []);

  useEffect(
    () => () => {
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
    },
    [],
  );

  // Keep scrollTop clamped if filtered list shrinks dramatically
  useEffect(() => {
    const node = containerRef.current;
    if (!node) {
      return;
    }
    const maxScroll = Math.max(0, items.length * ROW_HEIGHT - viewportHeight);
    if (node.scrollTop > maxScroll) {
      node.scrollTop = maxScroll;
      setScrollTop(maxScroll);
    } else if (node.scrollTop !== scrollTop) {
      setScrollTop(node.scrollTop);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length, viewportHeight]);

  // Programmatic scroll into view for Migrate stepper. Each (target, signal) request is handled
  // ONCE: `items` is a new array on every state push, and re-running on it kept yanking the list
  // back to the last stepped profile whenever the user scrolled elsewhere.
  const handledScrollRequestRef = useRef<string | null>(null);
  useEffect(() => {
    if (!scrollToUsername || !containerRef.current) {
      return;
    }
    const requestKey = `${scrollToUsername}|${scrollSignal ?? 0}`;
    if (handledScrollRequestRef.current === requestKey) {
      return;
    }
    const targetIdx = items.findIndex((item) => item.username === scrollToUsername);
    if (targetIdx < 0) {
      return; // not in this list (yet) — retry when items change
    }
    handledScrollRequestRef.current = requestKey;

    const node = containerRef.current;
    const rowTop = targetIdx * ROW_HEIGHT;
    const rowBottom = rowTop + ROW_HEIGHT;
    const viewTop = node.scrollTop;
    const viewBottom = viewTop + node.clientHeight;

    if (rowTop < viewTop) {
      node.scrollTo({ top: rowTop, behavior: 'smooth' });
    } else if (rowBottom > viewBottom) {
      node.scrollTo({ top: Math.max(0, rowBottom - node.clientHeight), behavior: 'smooth' });
    }
  }, [scrollToUsername, scrollSignal, items]);

  const { totalHeight, startIndex, visibleSlice } = useMemo(() => {
    const total = items.length * ROW_HEIGHT;
    const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const end = Math.min(
      items.length - 1,
      Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN,
    );
    return {
      totalHeight: total,
      startIndex: start,
      visibleSlice: end >= start ? items.slice(start, end + 1) : [],
    };
  }, [items, scrollTop, viewportHeight]);

  if (items.length === 0) {
    return (
      <div
        data-testid={`${testId}-empty`}
        className="flex flex-1 flex-col items-center justify-center px-6 py-12 text-center"
      >
        <p className="text-[12.5px] font-semibold text-zinc-700 dark:text-zinc-200">
          {emptyTitle}
        </p>
        {emptyDescription && (
          <p className="mt-1 max-w-[260px] text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
            {emptyDescription}
          </p>
        )}
      </div>
    );
  }

  return (
    <div
      ref={setContainerNode}
      data-testid={testId}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
    >
      <div style={{ height: totalHeight, position: 'relative' }}>
        {visibleSlice.map((account, offset) => {
          const absoluteIndex = startIndex + offset;
          const isSelected = Boolean(selectedSet?.has(account.username));
          const isVisiting = activeVisitedUsername === account.username;
          const isRunnerTarget = activeRunnerTarget === account.username;
          const statusPill = getStatusPill(account.status);
          const isMigrateIntent = account.intent === 'migrate';

          let rowHighlight = 'bg-transparent hover:bg-zinc-100/75 dark:hover:bg-white/[0.03]';
          if (isVisiting) {
            rowHighlight = 'bg-indigo-500/[0.08] dark:bg-indigo-500/[0.12]';
          } else if (isRunnerTarget) {
            rowHighlight = 'bg-amber-500/[0.08] dark:bg-amber-500/[0.12]';
          } else if (isSelected) {
            rowHighlight = 'bg-indigo-500/[0.05] dark:bg-indigo-500/[0.07]';
          }

          return (
            <div
              key={account.username}
              data-testid={`account-row-${account.username}`}
              style={{
                position: 'absolute',
                top: absoluteIndex * ROW_HEIGHT,
                left: 0,
                right: 0,
                height: ROW_HEIGHT,
              }}
              onClick={onRowClick ? () => onRowClick(account) : undefined}
              className={`flex items-center gap-2.5 border-b border-zinc-200/60 px-3 transition-colors dark:border-white/[0.05] ${rowHighlight} ${
                onRowClick ? 'cursor-pointer' : ''
              }`}
            >
              {selectable && onToggleSelect && (
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => onToggleSelect(account.username)}
                  onClick={(e) => e.stopPropagation()}
                  aria-label={`Select @${account.username}`}
                  data-testid={`select-row-${account.username}`}
                  className="h-3.5 w-3.5 shrink-0 cursor-pointer rounded border-zinc-300 text-indigo-600 focus:ring-indigo-500 dark:border-zinc-700 dark:bg-zinc-900"
                />
              )}

              <AccountAvatar account={account} />

              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1">
                  {onRowClick ? (
                    <a
                      href={account.profileUrl}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        onRowClick(account);
                      }}
                      data-testid={`profile-link-${account.username}`}
                      className="truncate text-[12px] font-semibold text-zinc-900 hover:text-indigo-600 hover:underline dark:text-zinc-100 dark:hover:text-indigo-300"
                    >
                      @{account.username}
                    </a>
                  ) : (
                    <span className="truncate text-[12px] font-semibold text-zinc-900 dark:text-zinc-100">
                      @{account.username}
                    </span>
                  )}

                  {account.isVerified && (
                    <BadgeCheck
                      aria-label="Verified"
                      className="h-3.5 w-3.5 shrink-0 text-sky-500"
                    />
                  )}

                  {isVisiting && (
                    <span
                      data-testid={`visiting-pill-${account.username}`}
                      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-indigo-500/35 bg-indigo-500/15 px-1.5 py-px text-[9.5px] font-semibold text-indigo-700 dark:text-indigo-300"
                    >
                      <span className="h-1.5 w-1.5 rounded-full bg-indigo-500" />
                      Visiting
                    </span>
                  )}

                  {isRunnerTarget && (
                    <span
                      data-testid={`runner-target-pill-${account.username}`}
                      className="inline-flex shrink-0 items-center rounded-full border border-amber-500/35 bg-amber-500/15 px-1.5 py-px text-[9.5px] font-semibold text-amber-700 dark:text-amber-300"
                    >
                      Next
                    </span>
                  )}
                </div>

                <div className="mt-0.5 flex items-center gap-1.5">
                  <span
                    dir="auto"
                    className="truncate text-[11px] text-zinc-500 dark:text-zinc-400"
                  >
                    {account.displayName || account.username}
                  </span>
                  <span
                    className={`inline-flex shrink-0 items-center rounded border px-1 py-px text-[9.5px] font-medium leading-tight ${statusPill.classes}`}
                  >
                    {statusPill.label}
                  </span>
                </div>
              </div>

              <div
                onClick={(e) => e.stopPropagation()}
                className="flex shrink-0 items-center gap-1.5"
              >
                {intentDisplayMode === 'compact' && onToggleIntent && (
                  <button
                    type="button"
                    data-testid={`intent-pill-${account.username}`}
                    onClick={() =>
                      onToggleIntent(account.username, isMigrateIntent ? 'drop' : 'migrate')
                    }
                    title={
                      isMigrateIntent
                        ? 'Intent: Keep for New Page (click to switch to Drop)'
                        : 'Intent: Drop Forever (click to switch to Migrate)'
                    }
                    className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold transition-colors ${
                      isMigrateIntent
                        ? 'border-indigo-500/30 bg-indigo-500/[0.12] text-indigo-700 hover:bg-indigo-500/20 dark:text-indigo-300'
                        : 'border-zinc-300/80 bg-zinc-100 text-zinc-600 hover:bg-zinc-200/70 dark:border-white/[0.08] dark:bg-zinc-800/80 dark:text-zinc-400 dark:hover:bg-zinc-800'
                    }`}
                  >
                    {isMigrateIntent ? 'Migrate' : 'Drop'}
                  </button>
                )}

                {intentDisplayMode === 'queue' && (
                  <button
                    type="button"
                    data-testid={`queue-intent-pill-${account.username}`}
                    disabled={!onToggleIntent}
                    onClick={() =>
                      onToggleIntent?.(account.username, isMigrateIntent ? 'drop' : 'migrate')
                    }
                    className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold transition-colors ${
                      isMigrateIntent
                        ? 'border-indigo-500/30 bg-indigo-500/[0.12] text-indigo-700 hover:bg-indigo-500/20 dark:text-indigo-300'
                        : 'border-rose-500/25 bg-rose-500/10 text-rose-700 hover:bg-rose-500/20 dark:text-rose-300'
                    }`}
                  >
                    {isMigrateIntent ? 'Will Keep for Migrate' : 'Will Drop'}
                  </button>
                )}

                {renderRowAction?.(account)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
