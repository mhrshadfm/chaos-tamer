import type { AccountMode, SafetySettings } from '../types/schema';
import { DAY_MS, HOUR_MS } from './constants';

export type RateZone = 'safe' | 'caution' | 'locked';

export interface WindowGauge {
  used: number;
  max: number;
  ratio: number;
  percent: number;
  zone: RateZone;
}

export interface RateLimitSnapshot {
  mode: AccountMode;
  hourly: WindowGauge;
  daily: WindowGauge;
  overallZone: RateZone;
  canAct: boolean;
  nextSlotAvailableInMs: number;
  cooldownFormatted: string;
}

function resolveZone(rawRatio: number): RateZone {
  if (rawRatio >= 1.0) {
    return 'locked';
  }
  if (rawRatio >= 0.7) {
    return 'caution';
  }
  return 'safe';
}

function buildWindowGauge(used: number, max: number): WindowGauge {
  if (max <= 0) {
    return {
      used,
      max: Math.max(0, max),
      ratio: 1,
      percent: 100,
      zone: 'locked',
    };
  }
  const rawRatio = used / max;
  const zone = resolveZone(rawRatio);
  const ratio = Math.min(1, Math.max(0, rawRatio));
  const percent =
    zone === 'locked' ? 100 : Math.min(99, Math.max(0, Math.round(rawRatio * 100)));

  return {
    used,
    max,
    ratio,
    percent,
    zone,
  };
}

function worstZone(a: RateZone, b: RateZone): RateZone {
  if (a === 'locked' || b === 'locked') {
    return 'locked';
  }
  if (a === 'caution' || b === 'caution') {
    return 'caution';
  }
  return 'safe';
}

/**
 * Prunes rolling action timestamps older than 24 hours (86,400,000 ms) and sorts ascending.
 */
export function pruneRollingTimestamps(timestamps: number[], now = Date.now()): number[] {
  const cutoff = now - DAY_MS;
  return timestamps
    .filter((ts) => typeof ts === 'number' && Number.isFinite(ts) && ts > cutoff)
    // A timestamp "in the future" means the clock moved backwards (or a backup came from a device
    // with a fast clock). Clamp it to now: dropping it would forget a real action and loosen the
    // caps, keeping it as-is would make it never expire.
    .map((ts) => (ts > now ? now : ts))
    .sort((a, b) => a - b);
}

/**
 * Multiset union of two rolling-timestamp lists: each value appears max(countA, countB) times.
 * Importing a backup exported from this same device therefore doesn't double-count actions,
 * while two genuinely distinct actions that share a millisecond are both kept (a plain Set
 * collapsed them into one and under-counted the caps).
 */
export function unionRollingTimestamps(
  local: number[],
  incoming: number[],
  now = Date.now(),
): number[] {
  const countOf = (list: number[]): Map<number, number> => {
    const counts = new Map<number, number>();
    for (const ts of list) {
      counts.set(ts, (counts.get(ts) ?? 0) + 1);
    }
    return counts;
  };
  const a = countOf(local);
  const b = countOf(incoming);
  const merged: number[] = [];
  for (const ts of new Set([...a.keys(), ...b.keys()])) {
    const n = Math.max(a.get(ts) ?? 0, b.get(ts) ?? 0);
    for (let i = 0; i < n; i += 1) {
      merged.push(ts);
    }
  }
  return pruneRollingTimestamps(merged, now);
}

/**
 * Evaluates exact rolling 60-minute and 24-hour rate-limit windows for the active or specified mode.
 */
export function evaluateRateLimit(
  safety: SafetySettings,
  modeOverride?: AccountMode,
  now = Date.now(),
): RateLimitSnapshot {
  const mode: AccountMode = modeOverride ?? safety.accountMode;
  const sourceTimestamps =
    mode === 'old_prune' ? safety.unfollowTimestamps : safety.followTimestamps;
  const modeLimits = safety.limits[mode];

  const timestamps24h = pruneRollingTimestamps(sourceTimestamps, now);
  const hourCutoff = now - HOUR_MS;
  const timestamps1h = timestamps24h.filter((ts) => ts > hourCutoff);

  const hourlyCount = timestamps1h.length;
  const dailyCount = timestamps24h.length;

  const hourly = buildWindowGauge(hourlyCount, modeLimits.maxPerHour);
  const daily = buildWindowGauge(dailyCount, modeLimits.maxPerDay);

  // A slot only frees up once enough timestamps age out to bring the count back BELOW the cap.
  // When usage overshoots the cap (manual actions tracked passively, or the user lowered the cap),
  // that is the (count - max)-th oldest timestamp, not simply the oldest one.
  let hourlyWait = 0;
  if (hourlyCount >= modeLimits.maxPerHour) {
    const releasingTs = timestamps1h[hourlyCount - Math.max(0, modeLimits.maxPerHour)];
    hourlyWait = releasingTs !== undefined ? releasingTs + HOUR_MS - now : HOUR_MS;
  }

  let dailyWait = 0;
  if (dailyCount >= modeLimits.maxPerDay) {
    const releasingTs = timestamps24h[dailyCount - Math.max(0, modeLimits.maxPerDay)];
    dailyWait = releasingTs !== undefined ? releasingTs + DAY_MS - now : DAY_MS;
  }

  const nextSlotAvailableInMs = Math.max(0, hourlyWait, dailyWait);
  const overallZone = worstZone(hourly.zone, daily.zone);
  const canAct = overallZone !== 'locked' && !safety.emergencyStopReason;

  return {
    mode,
    hourly,
    daily,
    overallZone,
    canAct,
    nextSlotAvailableInMs,
    cooldownFormatted: formatDurationMmSs(nextSlotAvailableInMs),
  };
}

/**
 * Samples an integer delay in [minSec, maxSec] using a Box-Muller Gaussian centered at
 * (minSec + maxSec) / 2 with standard deviation (maxSec - minSec) / 4.
 */
export function sampleTruncatedGaussianSec(minSec: number, maxSec: number): number {
  const low = Math.min(minSec, maxSec);
  const high = Math.max(minSec, maxSec);
  if (high <= low) {
    return Math.max(1, Math.round(low));
  }

  const u1 = Math.max(Number.EPSILON, Math.random());
  const u2 = Math.random();
  const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);

  const mean = (low + high) / 2;
  const sigma = (high - low) / 4;
  const sample = mean + z0 * sigma;
  const clamped = Math.min(high, Math.max(low, sample));

  return Math.max(1, Math.round(clamped));
}

/**
 * Formats millisecond durations as MM:SS (or HH:MM:SS when >= 1 hour).
 */
export function formatDurationMmSs(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');

  if (hours > 0) {
    const hh = String(hours).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }
  return `${mm}:${ss}`;
}
