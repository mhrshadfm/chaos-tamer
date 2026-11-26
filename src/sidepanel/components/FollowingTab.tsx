import React, { useCallback, useMemo, useState } from 'react';
import type { AccountIntent, AccountRecord } from '../../types/schema';
import type { BridgeResponse, ExtensionMessage } from '../../types/messages';
import { normalizeSearchText } from '../../lib/constants';
import { BulkToolbar, type FollowingFilterId } from './BulkToolbar';
import { VirtualAccountList } from './VirtualAccountList';

export interface FollowingTabProps {
  accounts: AccountRecord[];
  onDispatch: (msg: ExtensionMessage) => Promise<BridgeResponse>;
}

export const FollowingTab: React.FC<FollowingTabProps> = ({ accounts, onDispatch }) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<FollowingFilterId>('all');
  const [selectedRaw, setSelectedRaw] = useState<Set<string>>(() => new Set());

  const existingUsernames = useMemo(
    () => new Set(accounts.map((a) => a.username)),
    [accounts],
  );

  const selectedSet = useMemo(() => {
    const valid = new Set<string>();
    for (const u of selectedRaw) {
      if (existingUsernames.has(u)) {
        valid.add(u);
      }
    }
    return valid;
  }, [selectedRaw, existingUsernames]);

  const filterCounts = useMemo<Record<FollowingFilterId, number>>(() => {
    let following = 0;
    let migrate = 0;
    let drop = 0;
    let unfollowed = 0;

    for (const acc of accounts) {
      if (acc.status === 'following') following += 1;
      if (acc.intent === 'migrate') migrate += 1;
      if (acc.intent === 'drop') drop += 1;
      if (acc.status === 'unfollowed_migrate' || acc.status === 'unfollowed_dropped') {
        unfollowed += 1;
      }
    }

    return {
      all: accounts.length,
      following,
      migrate,
      drop,
      unfollowed,
    };
  }, [accounts]);

  const filteredAccounts = useMemo(() => {
    const normalizedQuery = normalizeSearchText(searchQuery).replace(/^@/, '');

    return accounts.filter((acc) => {
      if (activeFilter === 'following' && acc.status !== 'following') return false;
      if (activeFilter === 'migrate' && acc.intent !== 'migrate') return false;
      if (activeFilter === 'drop' && acc.intent !== 'drop') return false;
      if (
        activeFilter === 'unfollowed' &&
        acc.status !== 'unfollowed_migrate' &&
        acc.status !== 'unfollowed_dropped'
      ) {
        return false;
      }

      if (!normalizedQuery) return true;
      return (
        normalizeSearchText(acc.username).includes(normalizedQuery) ||
        normalizeSearchText(acc.displayName).includes(normalizedQuery)
      );
    });
  }, [accounts, activeFilter, searchQuery]);

  const { allVisibleSelected, someVisibleSelected } = useMemo(() => {
    if (filteredAccounts.length === 0) {
      return { allVisibleSelected: false, someVisibleSelected: false };
    }
    let count = 0;
    for (const acc of filteredAccounts) {
      if (selectedSet.has(acc.username)) {
        count += 1;
      }
    }
    return {
      allVisibleSelected: count === filteredAccounts.length,
      someVisibleSelected: count > 0,
    };
  }, [filteredAccounts, selectedSet]);

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
        for (const acc of filteredAccounts) {
          next.delete(acc.username);
        }
      } else {
        for (const acc of filteredAccounts) {
          next.add(acc.username);
        }
      }
      return next;
    });
  }, [allVisibleSelected, filteredAccounts]);

  const handleClearSelection = useCallback(() => {
    setSelectedRaw(new Set());
  }, []);

  const handleBulkSetIntent = useCallback(
    (intent: AccountIntent) => {
      const usernames = Array.from(selectedSet);
      if (usernames.length === 0) return;
      void onDispatch({ type: 'SET_INTENT_BULK', usernames, intent });
    },
    [selectedSet, onDispatch],
  );

  const handleBulkQueueSelected = useCallback(() => {
    const usernames = Array.from(selectedSet);
    if (usernames.length === 0) return;
    void onDispatch({ type: 'QUEUE_ACCOUNTS_BULK', usernames });
    setSelectedRaw(new Set());
  }, [selectedSet, onDispatch]);

  const handleRowIntentToggle = useCallback(
    (username: string, nextIntent: AccountIntent) => {
      void onDispatch({ type: 'SET_INTENT_BULK', usernames: [username], intent: nextIntent });
    },
    [onDispatch],
  );

  const renderRowAction = useCallback(
    (account: AccountRecord) => {
      if (account.status === 'following') {
        return (
          <button
            type="button"
            data-testid={`queue-row-btn-${account.username}`}
            onClick={() =>
              void onDispatch({ type: 'QUEUE_ACCOUNTS_BULK', usernames: [account.username] })
            }
            className="rounded-md border border-zinc-200/90 bg-white px-2 py-0.5 text-[10px] font-semibold text-zinc-700 transition-colors hover:border-zinc-300 hover:bg-zinc-100 dark:border-white/[0.1] dark:bg-[#111113] dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            + Queue
          </button>
        );
      }

      if (account.status === 'queued_unfollow') {
        return (
          <button
            type="button"
            data-testid={`unqueue-row-btn-${account.username}`}
            onClick={() =>
              void onDispatch({ type: 'UNQUEUE_ACCOUNTS_BULK', usernames: [account.username] })
            }
            title="Click to remove from Unfollow Queue"
            className="rounded-md border border-amber-500/35 bg-amber-500/[0.12] px-2 py-0.5 text-[10px] font-semibold text-amber-700 transition-colors hover:bg-amber-500/20 dark:text-amber-300"
          >
            Queued
          </button>
        );
      }

      return (
        <span className="px-1.5 text-[10px] font-medium text-zinc-400 dark:text-zinc-500">
          {account.status === 'migrated_following' || account.status === 'migrated_requested'
            ? 'Moved'
            : 'Pruned'}
        </span>
      );
    },
    [onDispatch],
  );

  return (
    <div data-testid="following-tab" className="flex min-h-0 flex-1 flex-col">
      <BulkToolbar
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        activeFilter={activeFilter}
        onFilterChange={setActiveFilter}
        filterCounts={filterCounts}
        visibleCount={filteredAccounts.length}
        selectedCount={selectedSet.size}
        allVisibleSelected={allVisibleSelected}
        someVisibleSelected={someVisibleSelected}
        onToggleSelectVisible={handleToggleSelectVisible}
        onClearSelection={handleClearSelection}
        onBulkSetIntent={handleBulkSetIntent}
        onBulkQueueSelected={handleBulkQueueSelected}
      />

      <VirtualAccountList
        testId="following-virtual-list"
        items={filteredAccounts}
        selectable
        selectedSet={selectedSet}
        onToggleSelect={handleToggleRowSelect}
        onToggleIntent={handleRowIntentToggle}
        intentDisplayMode="compact"
        renderRowAction={renderRowAction}
        emptyTitle={
          accounts.length === 0 ? 'No accounts extracted yet' : 'No matching accounts'
        }
        emptyDescription={
          accounts.length === 0
            ? 'Open your Instagram Following list and tap "Scan Following" above.'
            : 'Try clearing your search query or switching filter pills.'
        }
      />
    </div>
  );
};
