import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ShieldAlert, X } from 'lucide-react';
import type { AccountRecord, StorageStateV1 } from '../types/schema';
import type { BridgeResponse, ExtensionMessage } from '../types/messages';
import { evaluateRateLimit } from '../lib/rateLimiter';
import { normalizeSearchText } from '../lib/constants';
import {
  getStorageState,
  sendExtensionMessage,
  subscribeStorageState,
} from '../lib/chromeBridge';
import { TopStickyBar } from './components/TopStickyBar';
import { ActionBanner, type SidePanelTabId } from './components/ActionBanner';
import { FollowingTab } from './components/FollowingTab';
import { QueueTab } from './components/QueueTab';
import { MigrateTab, type MigrateFilterId } from './components/MigrateTab';
import { DataLimitsTab } from './components/DataLimitsTab';

function isMigratedDone(acc: AccountRecord): boolean {
  return acc.status === 'migrated_following' || acc.status === 'migrated_requested';
}

function isReadyToMigrate(acc: AccountRecord, includeFollowing: boolean): boolean {
  if (acc.status === 'unfollowed_migrate') return true;
  if (includeFollowing && acc.status === 'following' && acc.intent === 'migrate') {
    return true;
  }
  return false;
}

export const App: React.FC = () => {
  const [state, setState] = useState<StorageStateV1 | null>(null);
  const [activeTab, setActiveTab] = useState<SidePanelTabId>('following');
  const [bridgeError, setBridgeError] = useState<string | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());

  // Migrate Hub filter & stepper state
  const [migrateFilter, setMigrateFilter] = useState<MigrateFilterId>('ready');
  const [migrateSearch, setMigrateSearch] = useState('');
  const [scrollTarget, setScrollTarget] = useState<{
    username: string | null;
    signal: number;
  }>({ username: null, signal: 0 });
  const lastSteppedIndexRef = useRef<number>(-1);
  // Username of the profile most recently opened by the stepper. Read synchronously, so a quick
  // double-press can't open the same target twice while state.activeVisitedUsername is in flight.
  const lastSteppedUsernameRef = useRef<string | null>(null);

  // Initial load + live storage subscription
  useEffect(() => {
    let mounted = true;
    void getStorageState().then((initial) => {
      if (mounted) {
        setState(initial);
      }
    });

    const unsubscribe = subscribeStorageState((updated) => {
      if (mounted) {
        setState(updated);
      }
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  // Sync theme to documentElement.classList ('dark')
  useEffect(() => {
    const isDark = (state?.theme ?? 'dark') === 'dark';
    document.documentElement.classList.toggle('dark', isDark);
    document.documentElement.style.colorScheme = isDark ? 'dark' : 'light';
  }, [state?.theme]);

  // Live 1-second clock for rolling 1h/24h gauges & cooldown badges
  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => window.clearInterval(intervalId);
  }, []);

  const handleDispatch = useCallback(
    async (msg: ExtensionMessage): Promise<BridgeResponse> => {
      const response = await sendExtensionMessage(msg);
      if (response.state) {
        setState(response.state);
      }
      if (!response.ok && response.error) {
        setBridgeError(response.error);
      } else if (response.ok) {
        setBridgeError(null);
      }
      return response;
    },
    [],
  );

  const sortedAccounts = useMemo<AccountRecord[]>(() => {
    if (!state) return [];
    return Object.values(state.accounts).sort((a, b) => {
      if (a.extractedAt !== b.extractedAt) {
        return a.extractedAt - b.extractedAt;
      }
      return a.username.localeCompare(b.username);
    });
  }, [state]);

  const queuedCount = useMemo(
    () => sortedAccounts.filter((a) => a.status === 'queued_unfollow').length,
    [sortedAccounts],
  );

  const includeFollowingInMigrate = state?.includeFollowingInMigrate ?? false;

  const migrateFilterCounts = useMemo<Record<MigrateFilterId, number>>(() => {
    let ready = 0;
    let done = 0;
    let all = 0;

    for (const acc of sortedAccounts) {
      const accReady = isReadyToMigrate(acc, includeFollowingInMigrate);
      const accDone = isMigratedDone(acc);
      if (accReady) ready += 1;
      if (accDone) done += 1;
      if (acc.intent === 'migrate' || accDone) all += 1;
    }

    return { ready, done, all };
  }, [sortedAccounts, includeFollowingInMigrate]);

  const filteredMigrateItems = useMemo<AccountRecord[]>(() => {
    const normalized = normalizeSearchText(migrateSearch).replace(/^@/, '');

    return sortedAccounts.filter((acc) => {
      if (migrateFilter === 'ready' && !isReadyToMigrate(acc, includeFollowingInMigrate)) {
        return false;
      }
      if (migrateFilter === 'done' && !isMigratedDone(acc)) {
        return false;
      }
      if (migrateFilter === 'all' && acc.intent !== 'migrate' && !isMigratedDone(acc)) {
        return false;
      }

      if (!normalized) return true;
      return (
        normalizeSearchText(acc.username).includes(normalized) ||
        normalizeSearchText(acc.displayName).includes(normalized)
      );
    });
  }, [sortedAccounts, migrateFilter, migrateSearch, includeFollowingInMigrate]);

  const unmigratedStepPool = useMemo<AccountRecord[]>(() => {
    const inView = filteredMigrateItems.filter((acc) => !isMigratedDone(acc));
    if (inView.length > 0) {
      return inView;
    }
    if (migrateFilter === 'done') {
      return sortedAccounts.filter((acc) =>
        isReadyToMigrate(acc, includeFollowingInMigrate),
      );
    }
    return [];
  }, [filteredMigrateItems, migrateFilter, sortedAccounts, includeFollowingInMigrate]);

  const handleOpenNextProfile = useCallback(() => {
    if (unmigratedStepPool.length === 0) return;

    if (
      migrateFilter === 'done' &&
      filteredMigrateItems.every((acc) => isMigratedDone(acc))
    ) {
      setMigrateFilter('ready');
    }

    const currentVisited = lastSteppedUsernameRef.current ?? state?.activeVisitedUsername;
    const currentIndex = currentVisited
      ? unmigratedStepPool.findIndex((acc) => acc.username === currentVisited)
      : -1;

    let nextIndex = 0;
    if (currentIndex >= 0) {
      nextIndex = (currentIndex + 1) % unmigratedStepPool.length;
    } else if (lastSteppedIndexRef.current >= 0) {
      nextIndex = lastSteppedIndexRef.current % unmigratedStepPool.length;
    }

    lastSteppedIndexRef.current = nextIndex;
    const target = unmigratedStepPool[nextIndex];
    if (!target) return;
    lastSteppedUsernameRef.current = target.username;

    setScrollTarget((prev) => ({
      username: target.username,
      signal: prev.signal + 1,
    }));
    void handleDispatch({ type: 'OPEN_PROFILE_TAB', username: target.username });
  }, [
    unmigratedStepPool,
    migrateFilter,
    filteredMigrateItems,
    state?.activeVisitedUsername,
    handleDispatch,
  ]);

  // Keep the stepper's position in sync when a profile is opened by clicking its row (or from
  // another surface): Space then continues from THAT row, not from the last Space-stepped index.
  useEffect(() => {
    const visited = state?.activeVisitedUsername;
    if (!visited) return;
    lastSteppedUsernameRef.current = visited;
    const idx = unmigratedStepPool.findIndex((acc) => acc.username === visited);
    if (idx >= 0) {
      lastSteppedIndexRef.current = idx;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.activeVisitedUsername]);

  const activeRateSnapshot = useMemo(
    () => (state ? evaluateRateLimit(state.safety, undefined, now) : null),
    [state, now],
  );

  const pruneRateSnapshot = useMemo(
    () => (state ? evaluateRateLimit(state.safety, 'old_prune', now) : null),
    [state, now],
  );

  const warmupRateSnapshot = useMemo(
    () => (state ? evaluateRateLimit(state.safety, 'new_warmup', now) : null),
    [state, now],
  );

  if (!state || !activeRateSnapshot || !pruneRateSnapshot || !warmupRateSnapshot) {
    return (
      <div className="flex h-screen h-[100dvh] w-full items-center justify-center bg-[#f8f8fa] text-zinc-500 dark:bg-[#09090b] dark:text-zinc-400">
        <div className="flex items-center gap-2 text-[12px] font-medium">
          <span className="h-2 w-2 animate-pulse rounded-full bg-indigo-500" />
          Loading Chaos Tamer...
        </div>
      </div>
    );
  }

  const emergencyReason = state.safety.emergencyStopReason;

  return (
    <div className="flex h-screen h-[100dvh] w-full flex-col overflow-hidden bg-[#f8f8fa] text-zinc-900 dark:bg-[#09090b] dark:text-zinc-100">
      <div className="mx-auto flex h-full w-full max-w-[520px] flex-col overflow-hidden border-zinc-200/75 bg-[#f8f8fa] sm:border-x dark:border-white/[0.06] dark:bg-[#09090b]">
        {/* 1. Top Sticky Bar */}
        <TopStickyBar
          theme={state.theme}
          accountMode={state.safety.accountMode}
          rateSnapshot={activeRateSnapshot}
          isSettingsActive={activeTab === 'settings'}
          onSetMode={(mode) => void handleDispatch({ type: 'SET_ACCOUNT_MODE', mode })}
          onToggleTheme={() =>
            void handleDispatch({
              type: 'SET_THEME',
              theme: state.theme === 'dark' ? 'light' : 'dark',
            })
          }
          onOpenSettings={() => setActiveTab('settings')}
        />

        {/* 2. Emergency Circuit Breaker Banner (Global when emergencyStopReason is set) */}
        {emergencyReason && (
          <div
            role="alert"
            data-testid="emergency-circuit-breaker-banner"
            className="shrink-0 border-b border-rose-500/40 bg-rose-500/[0.12] px-3 py-2.5 text-rose-800 dark:bg-rose-950/60 dark:text-rose-200"
          >
            <div className="flex items-start justify-between gap-2.5">
              <div className="flex min-w-0 items-start gap-2">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-rose-600 dark:text-rose-400" />
                <div className="min-w-0">
                  <div className="text-[11.5px] font-semibold">
                    Emergency Circuit Breaker Tripped
                  </div>
                  <p className="mt-0.5 break-words text-[10.5px] leading-snug opacity-90">
                    {emergencyReason}
                  </p>
                </div>
              </div>

              <button
                type="button"
                data-testid="clear-circuit-breaker-btn"
                onClick={() => void handleDispatch({ type: 'CLEAR_CIRCUIT_BREAKER' })}
                className="shrink-0 rounded-lg bg-rose-600 px-2.5 py-1.5 text-[10.5px] font-semibold text-white shadow-sm transition-colors hover:bg-rose-500"
              >
                Clear Lock &amp; Acknowledge
              </button>
            </div>
          </div>
        )}

        {/* Optional Bridge Error Toast */}
        {bridgeError && (
          <div
            role="status"
            data-testid="bridge-error-banner"
            className="flex shrink-0 items-center justify-between gap-2 border-b border-amber-500/35 bg-amber-500/10 px-3 py-1.5 text-[11px] font-medium text-amber-800 dark:text-amber-200"
          >
            <div className="flex min-w-0 items-center gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{bridgeError}</span>
            </div>
            <button
              type="button"
              onClick={() => setBridgeError(null)}
              aria-label="Dismiss notice"
              className="rounded p-0.5 hover:bg-amber-500/20"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )}

        {/* 3. Contextual Action Banner */}
        <ActionBanner
          activeTab={activeTab}
          scraper={state.scraper}
          runner={state.runner}
          automationConfig={state.safety.automationConfig}
          totalStoredCount={sortedAccounts.length}
          queuedCount={queuedCount}
          migrateMovedCount={migrateFilterCounts.done}
          migrateTotalCount={migrateFilterCounts.ready + migrateFilterCounts.done}
          hasNextMigrateTarget={unmigratedStepPool.length > 0}
          pruneRateSnapshot={pruneRateSnapshot}
          warmupRateSnapshot={warmupRateSnapshot}
          circuitTripped={Boolean(emergencyReason)}
          onScraperCommand={(action) =>
            void handleDispatch({ type: 'SCRAPER_COMMAND', action })
          }
          onRunnerCommand={(action) =>
            void handleDispatch({ type: 'RUNNER_COMMAND', action })
          }
          onOpenNextProfile={handleOpenNextProfile}
        />

        {/* 4. Segmented Navigation (4 Tabs) */}
        <nav
          aria-label="Primary sections"
          className="shrink-0 border-b border-zinc-200/80 bg-white px-3 py-1.5 [@media(max-height:520px)]:py-1 dark:border-white/[0.08] dark:bg-[#111113]"
        >
          <div className="grid grid-cols-4 gap-1 rounded-lg border border-zinc-200/80 bg-zinc-100/90 p-0.5 dark:border-white/[0.06] dark:bg-zinc-950/90">
            <button
              type="button"
              data-testid="tab-following"
              onClick={() => setActiveTab('following')}
              aria-current={activeTab === 'following' ? 'page' : undefined}
              className={`flex items-center justify-center gap-1 rounded-[6px] px-1.5 py-1 text-[11px] font-semibold transition-all ${
                activeTab === 'following'
                  ? 'bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-100'
                  : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200'
              }`}
            >
              <span>Following</span>
              <span className="rounded bg-zinc-200/80 px-1 py-px text-[9.5px] tabular-nums text-zinc-700 dark:bg-zinc-700/80 dark:text-zinc-200">
                {sortedAccounts.length}
              </span>
            </button>

            <button
              type="button"
              data-testid="tab-queue"
              onClick={() => setActiveTab('queue')}
              aria-current={activeTab === 'queue' ? 'page' : undefined}
              className={`flex items-center justify-center gap-1 rounded-[6px] px-1.5 py-1 text-[11px] font-semibold transition-all ${
                activeTab === 'queue'
                  ? 'bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-100'
                  : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200'
              }`}
            >
              <span>Queue</span>
              <span className="rounded bg-zinc-200/80 px-1 py-px text-[9.5px] tabular-nums text-zinc-700 dark:bg-zinc-700/80 dark:text-zinc-200">
                {queuedCount}
              </span>
            </button>

            <button
              type="button"
              data-testid="tab-migrate"
              onClick={() => setActiveTab('migrate')}
              aria-current={activeTab === 'migrate' ? 'page' : undefined}
              className={`flex items-center justify-center gap-1 rounded-[6px] px-1.5 py-1 text-[11px] font-semibold transition-all ${
                activeTab === 'migrate'
                  ? 'bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-100'
                  : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200'
              }`}
            >
              <span>Migrate</span>
              <span className="rounded bg-zinc-200/80 px-1 py-px text-[9.5px] tabular-nums text-zinc-700 dark:bg-zinc-700/80 dark:text-zinc-200">
                {migrateFilterCounts.ready}
              </span>
            </button>

            <button
              type="button"
              data-testid="tab-settings"
              onClick={() => setActiveTab('settings')}
              aria-current={activeTab === 'settings' ? 'page' : undefined}
              className={`flex items-center justify-center rounded-[6px] px-1.5 py-1 text-[11px] font-semibold transition-all ${
                activeTab === 'settings'
                  ? 'bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-100'
                  : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200'
              }`}
            >
              <span className="truncate">Data &amp; Limits</span>
            </button>
          </div>
        </nav>

        {/* 5. Active Tab Body */}
        <main className="flex min-h-0 flex-1 flex-col">
          {activeTab === 'following' && (
            <FollowingTab accounts={sortedAccounts} onDispatch={handleDispatch} />
          )}

          {activeTab === 'queue' && (
            <QueueTab
              accounts={sortedAccounts}
              runner={state.runner}
              onDispatch={handleDispatch}
            />
          )}

          {activeTab === 'migrate' && (
            <MigrateTab
              items={filteredMigrateItems}
              filterCounts={migrateFilterCounts}
              activeFilter={migrateFilter}
              onFilterChange={setMigrateFilter}
              searchQuery={migrateSearch}
              onSearchChange={setMigrateSearch}
              includeFollowingInMigrate={includeFollowingInMigrate}
              activeVisitedUsername={state.activeVisitedUsername}
              scrollToUsername={scrollTarget.username}
              scrollSignal={scrollTarget.signal}
              onOpenNextProfile={handleOpenNextProfile}
              onDispatch={handleDispatch}
            />
          )}

          {activeTab === 'settings' && (
            <DataLimitsTab state={state} onDispatch={handleDispatch} />
          )}
        </main>
      </div>
    </div>
  );
};
