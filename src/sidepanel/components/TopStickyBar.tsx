import React from 'react';
import { Moon, SlidersHorizontal, Sun } from 'lucide-react';
import type { AccountMode, ThemeMode } from '../../types/schema';
import {
  EXTENSION_AUTHOR,
  EXTENSION_AUTHOR_URL,
  EXTENSION_NAME,
} from '../../lib/constants';
import {
  formatDurationMmSs,
  type RateLimitSnapshot,
  type RateZone,
  type WindowGauge,
} from '../../lib/rateLimiter';
import { isLiveHostContext } from '../../lib/chromeBridge';

export interface TopStickyBarProps {
  theme: ThemeMode;
  accountMode: AccountMode;
  rateSnapshot: RateLimitSnapshot;
  isSettingsActive: boolean;
  onSetMode: (mode: AccountMode) => void;
  onToggleTheme: () => void;
  onOpenSettings: () => void;
}

function getZoneBarClass(zone: RateZone): string {
  switch (zone) {
    case 'safe':
      return 'bg-emerald-500';
    case 'caution':
      return 'bg-amber-500';
    case 'locked':
      return 'bg-rose-500';
  }
}

function getZoneTextClass(zone: RateZone): string {
  switch (zone) {
    case 'safe':
      return 'text-emerald-600 dark:text-emerald-400';
    case 'caution':
      return 'text-amber-600 dark:text-amber-400';
    case 'locked':
      return 'text-rose-600 dark:text-rose-400';
  }
}

interface GaugeBarProps {
  label: string;
  gauge: WindowGauge;
  cooldownMs: number;
  testId: string;
}

const GaugeBar: React.FC<GaugeBarProps> = ({ label, gauge, cooldownMs, testId }) => {
  const clampedPercent = Math.min(100, Math.max(0, Math.round(gauge.ratio * 100)));

  return (
    <div
      data-testid={testId}
      className="flex-1 rounded-lg border border-zinc-200/80 bg-zinc-50/90 px-2.5 py-1.5 [@media(max-height:520px)]:px-2 [@media(max-height:520px)]:py-1 dark:border-white/[0.07] dark:bg-[#111113]"
    >
      <div className="flex items-center justify-between gap-1 text-[11px] leading-none">
        <span className="font-medium text-zinc-500 dark:text-zinc-400">{label}</span>
        <div className="flex items-center gap-1.5 tabular-nums">
          {gauge.zone === 'locked' && cooldownMs > 0 && (
            <span
              data-testid={`${testId}-cooldown`}
              className="rounded bg-rose-500/15 px-1 py-0.5 text-[10px] font-semibold text-rose-600 dark:text-rose-400"
            >
              {formatDurationMmSs(cooldownMs)}
            </span>
          )}
          <span className={`font-semibold ${getZoneTextClass(gauge.zone)}`}>
            {gauge.used}/{gauge.max}
          </span>
        </div>
      </div>
      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-zinc-200/90 [@media(max-height:520px)]:mt-1 [@media(max-height:520px)]:h-1 dark:bg-zinc-800/90">
        <div
          className={`h-full rounded-full transition-all duration-300 ${getZoneBarClass(gauge.zone)}`}
          style={{ width: `${clampedPercent}%` }}
        />
      </div>
    </div>
  );
};

export const TopStickyBar: React.FC<TopStickyBarProps> = ({
  theme,
  accountMode,
  rateSnapshot,
  isSettingsActive,
  onSetMode,
  onToggleTheme,
  onOpenSettings,
}) => {
  const devMock = !isLiveHostContext();
  const actionVerb = accountMode === 'old_prune' ? 'Unfollow' : 'Follow';

  return (
    <header
      data-testid="top-sticky-bar"
      className="sticky top-0 z-20 shrink-0 border-b border-zinc-200/80 bg-white/85 px-3 py-2.5 backdrop-blur-md [@media(max-height:520px)]:py-1.5 dark:border-white/[0.08] dark:bg-zinc-950/80"
    >
      {/* Row 1: Brand cluster + utility buttons */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5 [@media(max-height:520px)]:gap-2">
          {/* Sleek 28x28 dark charcoal/obsidian squircle badge so pure white emblem pops in both Light & Dark mode */}
          <div
            data-testid="brand-logo-badge"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] border border-white/15 bg-zinc-950 shadow-sm [@media(max-height:520px)]:h-6 [@media(max-height:520px)]:w-6"
          >
            <img
              src="/icons/logo-white.png"
              alt="Chaos Tamer logo"
              className="h-[18px] w-[18px] select-none object-contain [@media(max-height:520px)]:h-4 [@media(max-height:520px)]:w-4"
              draggable={false}
            />
          </div>

          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <h1 className="truncate text-[13px] font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
                {EXTENSION_NAME}
              </h1>
              {devMock && (
                <span
                  data-testid="dev-mock-badge"
                  className="shrink-0 rounded-full border border-amber-500/30 bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-300"
                >
                  DEV MOCK
                </span>
              )}
            </div>
            <a
              href={EXTENSION_AUTHOR_URL}
              target="_blank"
              rel="noreferrer"
              data-testid="header-author-link"
              className="inline-flex items-center text-[10.5px] font-medium text-zinc-500 transition-colors hover:text-zinc-900 [@media(max-height:520px)]:hidden dark:text-zinc-400 dark:hover:text-zinc-200"
            >
              by {EXTENSION_AUTHOR}
            </a>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={onToggleTheme}
            data-testid="theme-toggle-btn"
            aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            className="flex h-7 w-7 items-center justify-center rounded-md border border-zinc-200/80 bg-white text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:border-white/[0.08] dark:bg-[#111113] dark:text-zinc-400 dark:hover:bg-zinc-800/80 dark:hover:text-zinc-100"
          >
            {theme === 'dark' ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
          </button>

          <button
            type="button"
            onClick={onOpenSettings}
            data-testid="quick-settings-btn"
            aria-label="Open Data & Limits settings"
            title="Data & Limits"
            className={`flex h-7 w-7 items-center justify-center rounded-md border transition-colors ${
              isSettingsActive
                ? 'border-indigo-500/40 bg-indigo-500/15 text-indigo-600 dark:text-indigo-300'
                : 'border-zinc-200/80 bg-white text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:border-white/[0.08] dark:bg-[#111113] dark:text-zinc-400 dark:hover:bg-zinc-800/80 dark:hover:text-zinc-100'
            }`}
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Row 2: Mode Switcher Segmented Pill */}
      <div
        role="group"
        aria-label="Account operation mode"
        className="mt-2.5 grid grid-cols-2 gap-1 rounded-lg border border-zinc-200/80 bg-zinc-100/90 p-0.5 [@media(max-height:520px)]:mt-1.5 dark:border-white/[0.06] dark:bg-[#111113]"
      >
        <button
          type="button"
          data-testid="mode-old-prune-btn"
          onClick={() => onSetMode('old_prune')}
          aria-pressed={accountMode === 'old_prune'}
          className={`rounded-[6px] px-2 py-1 text-[11px] font-medium transition-all [@media(max-height:520px)]:py-0.5 ${
            accountMode === 'old_prune'
              ? 'bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-100'
              : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200'
          }`}
        >
          Old Page: Prune
        </button>
        <button
          type="button"
          data-testid="mode-new-warmup-btn"
          onClick={() => onSetMode('new_warmup')}
          aria-pressed={accountMode === 'new_warmup'}
          className={`rounded-[6px] px-2 py-1 text-[11px] font-medium transition-all [@media(max-height:520px)]:py-0.5 ${
            accountMode === 'new_warmup'
              ? 'bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-100'
              : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200'
          }`}
        >
          New Page: Follow
        </button>
      </div>

      {/* Row 3: Live Rolling Rate-Limit Gauges (1h & 24h) */}
      <div className="mt-2 flex items-center gap-2 [@media(max-height:520px)]:mt-1.5">
        <GaugeBar
          label={`1h ${actionVerb}`}
          gauge={rateSnapshot.hourly}
          cooldownMs={rateSnapshot.nextSlotAvailableInMs}
          testId="rate-gauge-1h"
        />
        <GaugeBar
          label={`24h ${actionVerb}`}
          gauge={rateSnapshot.daily}
          cooldownMs={rateSnapshot.nextSlotAvailableInMs}
          testId="rate-gauge-24h"
        />
      </div>
    </header>
  );
};
