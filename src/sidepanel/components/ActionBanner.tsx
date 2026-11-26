import React from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Clock,
  Pause,
  Play,
  RefreshCw,
  Square,
} from 'lucide-react';
import type {
  AutomationConfig,
  RunnerLiveState,
  ScraperLiveState,
} from '../../types/schema';
import { formatDurationMmSs, type RateLimitSnapshot } from '../../lib/rateLimiter';

export type SidePanelTabId = 'following' | 'queue' | 'migrate' | 'settings';

export interface ActionBannerProps {
  activeTab: SidePanelTabId;
  scraper: ScraperLiveState;
  runner: RunnerLiveState;
  automationConfig: AutomationConfig;
  totalStoredCount: number;
  queuedCount: number;
  migrateMovedCount: number;
  migrateTotalCount: number;
  hasNextMigrateTarget: boolean;
  pruneRateSnapshot: RateLimitSnapshot;
  warmupRateSnapshot: RateLimitSnapshot;
  circuitTripped: boolean;
  onScraperCommand: (action: 'start' | 'pause' | 'resume' | 'stop') => void;
  onRunnerCommand: (action: 'start' | 'pause' | 'resume' | 'stop') => void;
  onOpenNextProfile: () => void;
}

function getScraperBadge(scrollState: ScraperLiveState['scrollState']): {
  label: string;
  classes: string;
} {
  switch (scrollState) {
    case 'scanning':
      return {
        label: 'Scanning',
        classes: 'border-emerald-500/30 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
      };
    case 'reading_pause':
      return {
        label: 'Reading Pause',
        classes: 'border-sky-500/30 bg-sky-500/15 text-sky-700 dark:text-sky-300',
      };
    case 'paused':
      return {
        label: 'Paused',
        classes: 'border-amber-500/30 bg-amber-500/15 text-amber-700 dark:text-amber-300',
      };
    case 'completed':
      return {
        label: 'Completed',
        classes: 'border-indigo-500/30 bg-indigo-500/15 text-indigo-700 dark:text-indigo-300',
      };
    case 'error':
      return {
        label: 'Action Needed',
        classes: 'border-rose-500/30 bg-rose-500/15 text-rose-700 dark:text-rose-300',
      };
    case 'idle':
    default:
      return {
        label: 'Idle',
        classes: 'border-zinc-300/70 bg-zinc-200/60 text-zinc-600 dark:border-white/[0.08] dark:bg-zinc-800/80 dark:text-zinc-400',
      };
  }
}

function getRunnerBadge(state: RunnerLiveState['state']): {
  label: string;
  classes: string;
} {
  switch (state) {
    case 'running':
      return {
        label: 'Running',
        classes: 'border-emerald-500/30 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
      };
    case 'micro_break':
      return {
        label: 'Micro-Break',
        classes: 'border-indigo-500/30 bg-indigo-500/15 text-indigo-700 dark:text-indigo-300',
      };
    case 'cooldown_paused':
      return {
        label: 'Rate Cooldown',
        classes: 'border-amber-500/30 bg-amber-500/15 text-amber-700 dark:text-amber-300',
      };
    case 'paused':
      return {
        label: 'Paused',
        classes: 'border-amber-500/30 bg-amber-500/15 text-amber-700 dark:text-amber-300',
      };
    case 'circuit_tripped':
      return {
        label: 'Circuit Locked',
        classes: 'border-rose-500/30 bg-rose-500/15 text-rose-700 dark:text-rose-300',
      };
    case 'idle':
    default:
      return {
        label: 'Ready',
        classes: 'border-zinc-300/70 bg-zinc-200/60 text-zinc-600 dark:border-white/[0.08] dark:bg-zinc-800/80 dark:text-zinc-400',
      };
  }
}

export const ActionBanner: React.FC<ActionBannerProps> = ({
  activeTab,
  scraper,
  runner,
  automationConfig,
  totalStoredCount,
  queuedCount,
  migrateMovedCount,
  migrateTotalCount,
  hasNextMigrateTarget,
  pruneRateSnapshot,
  warmupRateSnapshot,
  circuitTripped,
  onScraperCommand,
  onRunnerCommand,
  onOpenNextProfile,
}) => {
  if (activeTab === 'following') {
    const badge = getScraperBadge(scraper.scrollState);
    const isActiveScan =
      scraper.scrollState === 'scanning' || scraper.scrollState === 'reading_pause';
    const isPausedScan = scraper.scrollState === 'paused';

    return (
      <section
        data-testid="action-banner-following"
        aria-label="Following scanner controls"
        className="shrink-0 border-b border-zinc-200/80 bg-white px-3 py-2.5 [@media(max-height:520px)]:py-1.5 dark:border-white/[0.08] dark:bg-[#111113]"
      >
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span
                data-testid="scraper-status-pill"
                className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${badge.classes}`}
              >
                {badge.label}
              </span>
              <span
                data-testid="scraper-extracted-counter"
                className="text-[11.5px] font-semibold tabular-nums text-zinc-800 dark:text-zinc-200"
              >
                {totalStoredCount} stored
                {scraper.sessionNewCount > 0 ? ` (+${scraper.sessionNewCount} new)` : ''}
              </span>
            </div>
            <p className="mt-1 truncate text-[11px] text-zinc-500 [@media(max-height:520px)]:mt-0.5 dark:text-zinc-400">
              {scraper.statusText ||
                'Open your Instagram Following list, then scan to harvest accounts.'}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            {!isActiveScan && !isPausedScan && (
              <button
                type="button"
                data-testid="scan-following-btn"
                disabled={circuitTripped}
                onClick={() => onScraperCommand('start')}
                className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 px-2.5 py-1.5 text-[11.5px] font-semibold text-white shadow-sm transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-45 [@media(max-height:520px)]:py-1 dark:bg-zinc-100 dark:text-zinc-950 dark:hover:bg-white"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Scan Following
              </button>
            )}

            {isActiveScan && (
              <>
                <button
                  type="button"
                  data-testid="scraper-pause-btn"
                  onClick={() => onScraperCommand('pause')}
                  className="inline-flex items-center gap-1 rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-zinc-800 hover:bg-zinc-100 dark:border-white/[0.12] dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
                >
                  <Pause className="h-3 w-3" />
                  Pause
                </button>
                <button
                  type="button"
                  data-testid="scraper-stop-btn"
                  onClick={() => onScraperCommand('stop')}
                  className="inline-flex items-center gap-1 rounded-lg border border-rose-500/30 bg-rose-500/10 px-2 py-1.5 text-[11px] font-semibold text-rose-600 hover:bg-rose-500/20 dark:text-rose-300"
                >
                  <Square className="h-3 w-3" />
                  Stop
                </button>
              </>
            )}

            {isPausedScan && (
              <>
                <button
                  type="button"
                  data-testid="scraper-resume-btn"
                  onClick={() => onScraperCommand('resume')}
                  className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1.5 text-[11px] font-semibold text-white hover:bg-emerald-500"
                >
                  <Play className="h-3 w-3" />
                  Resume
                </button>
                <button
                  type="button"
                  data-testid="scraper-stop-btn"
                  onClick={() => onScraperCommand('stop')}
                  className="inline-flex items-center gap-1 rounded-lg border border-rose-500/30 bg-rose-500/10 px-2 py-1.5 text-[11px] font-semibold text-rose-600 hover:bg-rose-500/20 dark:text-rose-300"
                >
                  <Square className="h-3 w-3" />
                  Stop
                </button>
              </>
            )}
          </div>
        </div>
      </section>
    );
  }

  if (activeTab === 'queue') {
    const badge = getRunnerBadge(runner.state);
    const isRunningGroup =
      runner.state === 'running' ||
      runner.state === 'micro_break' ||
      runner.state === 'cooldown_paused';
    const isPaused = runner.state === 'paused';

    let detailLine =
      runner.statusText ||
      `${queuedCount} queued · ${automationConfig.minDelaySec}–${automationConfig.maxDelaySec}s Gaussian · ${automationConfig.breakMinMinutes}–${automationConfig.breakMaxMinutes}m break/${automationConfig.batchSizeBeforeBreak}`;

    if (runner.state === 'running' && runner.currentTarget && runner.countdownSec > 0) {
      detailLine = `Next unfollow (@${runner.currentTarget}) in ${runner.countdownSec}s`;
    } else if (runner.state === 'micro_break') {
      detailLine = `Batch micro-break (${automationConfig.breakMinMinutes}–${automationConfig.breakMaxMinutes}m after ${automationConfig.batchSizeBeforeBreak} items) · ${formatDurationMmSs(runner.countdownSec * 1000)}`;
    } else if (runner.state === 'cooldown_paused') {
      const waitMs = Math.max(runner.countdownSec * 1000, pruneRateSnapshot.nextSlotAvailableInMs);
      detailLine = `Rolling cap cooldown · resumes in ${formatDurationMmSs(waitMs)}`;
    }

    return (
      <section
        data-testid="action-banner-queue"
        aria-label="Safe auto-unfollow controls"
        className="shrink-0 border-b border-zinc-200/80 bg-white px-3 py-2.5 [@media(max-height:520px)]:py-1.5 dark:border-white/[0.08] dark:bg-[#111113]"
      >
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <span
                data-testid="runner-status-pill"
                className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${badge.classes}`}
              >
                {badge.label}
              </span>
              <span className="text-[11px] font-medium tabular-nums text-zinc-600 dark:text-zinc-300">
                {runner.sessionUnfollowedCount} unfollowed this session
              </span>
              <span className="inline-flex items-center gap-1 rounded border border-zinc-200/80 bg-zinc-100/80 px-1.5 py-0.5 text-[10px] tabular-nums text-zinc-500 dark:border-white/[0.07] dark:bg-zinc-900 dark:text-zinc-400">
                <Clock className="h-2.5 w-2.5" />
                {automationConfig.breakMinMinutes}–{automationConfig.breakMaxMinutes}m /{' '}
                {automationConfig.batchSizeBeforeBreak}
              </span>
            </div>
            <p
              data-testid="runner-countdown-text"
              className="mt-1 truncate text-[11px] tabular-nums text-zinc-600 dark:text-zinc-300"
            >
              {detailLine}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            {!isRunningGroup && !isPaused && (
              <button
                type="button"
                data-testid="start-runner-btn"
                disabled={queuedCount === 0 || circuitTripped}
                onClick={() => onRunnerCommand('start')}
                className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 px-2.5 py-1.5 text-[11.5px] font-semibold text-white shadow-sm transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-45 dark:bg-zinc-100 dark:text-zinc-950 dark:hover:bg-white"
              >
                <Play className="h-3.5 w-3.5" />
                Start Safe Auto-Unfollow
              </button>
            )}

            {isRunningGroup && (
              <>
                <button
                  type="button"
                  data-testid="runner-pause-btn"
                  onClick={() => onRunnerCommand('pause')}
                  className="inline-flex items-center gap-1 rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-zinc-800 hover:bg-zinc-100 dark:border-white/[0.12] dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
                >
                  <Pause className="h-3 w-3" />
                  Pause
                </button>
                <button
                  type="button"
                  data-testid="runner-stop-btn"
                  onClick={() => onRunnerCommand('stop')}
                  className="inline-flex items-center gap-1 rounded-lg border border-rose-500/30 bg-rose-500/10 px-2 py-1.5 text-[11px] font-semibold text-rose-600 hover:bg-rose-500/20 dark:text-rose-300"
                >
                  <Square className="h-3 w-3" />
                  Stop
                </button>
              </>
            )}

            {isPaused && (
              <>
                <button
                  type="button"
                  data-testid="runner-resume-btn"
                  onClick={() => onRunnerCommand('resume')}
                  className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1.5 text-[11px] font-semibold text-white hover:bg-emerald-500"
                >
                  <Play className="h-3 w-3" />
                  Resume
                </button>
                <button
                  type="button"
                  data-testid="runner-stop-btn"
                  onClick={() => onRunnerCommand('stop')}
                  className="inline-flex items-center gap-1 rounded-lg border border-rose-500/30 bg-rose-500/10 px-2 py-1.5 text-[11px] font-semibold text-rose-600 hover:bg-rose-500/20 dark:text-rose-300"
                >
                  <Square className="h-3 w-3" />
                  Stop
                </button>
              </>
            )}
          </div>
        </div>
      </section>
    );
  }

  if (activeTab === 'migrate') {
    const progressPercent =
      migrateTotalCount > 0
        ? Math.min(100, Math.round((migrateMovedCount / migrateTotalCount) * 100))
        : 0;
    const warmupZone = warmupRateSnapshot.overallZone;

    return (
      <section
        data-testid="action-banner-migrate"
        aria-label="Migration progress and quick-stepper"
        className="shrink-0 border-b border-zinc-200/80 bg-white px-3 py-2.5 [@media(max-height:520px)]:py-1.5 dark:border-white/[0.08] dark:bg-[#111113]"
      >
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between text-[11.5px]">
              <span
                data-testid="migrate-progress-label"
                className="font-semibold tabular-nums text-zinc-900 dark:text-zinc-100"
              >
                {migrateMovedCount} / {migrateTotalCount} Moved • {progressPercent}%
              </span>
              <span className="hidden text-[10px] text-zinc-400 sm:inline">
                Press <kbd className="rounded border border-zinc-300/80 px-1 py-px font-sans text-[9.5px] dark:border-white/15">Space</kbd> for next
              </span>
            </div>
            <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-zinc-200/90 dark:bg-zinc-800">
              <div
                data-testid="migrate-progress-bar"
                className="h-full rounded-full bg-indigo-500 transition-all duration-300"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          </div>

          <button
            type="button"
            data-testid="open-next-profile-btn"
            disabled={!hasNextMigrateTarget}
            onClick={onOpenNextProfile}
            className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-zinc-900 px-2.5 py-1.5 text-[11.5px] font-semibold text-white shadow-sm transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-950 dark:hover:bg-white"
          >
            Open Next Profile
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </div>

        {warmupZone !== 'safe' && (
          <div
            data-testid="migrate-warmup-warning"
            className={`mt-2 flex items-center gap-1.5 rounded-md border px-2 py-1 text-[10.5px] font-medium tabular-nums ${
              warmupZone === 'locked'
                ? 'border-rose-500/35 bg-rose-500/10 text-rose-700 dark:text-rose-300'
                : 'border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-300'
            }`}
          >
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            <span>
              {warmupZone === 'locked'
                ? `New Page follow cap reached (${warmupRateSnapshot.hourly.used}/${warmupRateSnapshot.hourly.max} 1h · ${warmupRateSnapshot.daily.used}/${warmupRateSnapshot.daily.max} 24h) — cooldown ${formatDurationMmSs(warmupRateSnapshot.nextSlotAvailableInMs)}`
                : `Approaching New Page follow cap (${warmupRateSnapshot.hourly.used}/${warmupRateSnapshot.hourly.max} 1h · ${warmupRateSnapshot.daily.used}/${warmupRateSnapshot.daily.max} 24h) — pace manual follows`}
            </span>
          </div>
        )}
      </section>
    );
  }

  return (
    <section
      data-testid="action-banner-settings"
      aria-label="Storage and portability summary"
      className="shrink-0 border-b border-zinc-200/80 bg-white px-3 py-2 dark:border-white/[0.08] dark:bg-[#111113]"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] tabular-nums">
        <div className="flex items-center gap-2 font-medium text-zinc-700 dark:text-zinc-200">
          <span>{totalStoredCount} stored</span>
          <span className="text-zinc-300 dark:text-zinc-700">•</span>
          <span>{queuedCount} queued</span>
          <span className="text-zinc-300 dark:text-zinc-700">•</span>
          <span>{migrateMovedCount} migrated</span>
        </div>
        <span className="text-[10.5px] text-zinc-500 dark:text-zinc-400">
          Cross-profile ready via JSON Backup
        </span>
      </div>
    </section>
  );
};
