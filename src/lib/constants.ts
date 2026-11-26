import type {
  AutomationConfig,
  RunnerLiveState,
  SafetySettings,
  ScraperLiveState,
  StorageStateV1,
} from '../types/schema';

export const STORAGE_KEY = 'chaos_tamer_state_v1';
export const EXTENSION_NAME = 'Chaos Tamer';
export const EXTENSION_AUTHOR = '@mhrshadfm';
export const EXTENSION_AUTHOR_URL = 'https://www.instagram.com/mhrshadfm/';

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

export const DEFAULT_AUTOMATION_CONFIG: AutomationConfig = {
  minDelaySec: 28,
  maxDelaySec: 58,
  batchSizeBeforeBreak: 12,
  breakMinMinutes: 5,
  breakMaxMinutes: 8,
  profileFallback: false,
  autoResumeAfterCooldown: true,
};

export const DEFAULT_SAFETY_SETTINGS: SafetySettings = {
  accountMode: 'old_prune',
  unfollowTimestamps: [],
  followTimestamps: [],
  limits: {
    old_prune: { maxPerHour: 15, maxPerDay: 80 },
    new_warmup: { maxPerHour: 10, maxPerDay: 35 },
  },
  automationConfig: { ...DEFAULT_AUTOMATION_CONFIG },
};

export const DEFAULT_SCRAPER_STATE: ScraperLiveState = {
  scrollState: 'idle',
  extractedCount: 0,
  sessionNewCount: 0,
  stepCount: 0,
  retryCount: 0,
};

export const DEFAULT_RUNNER_STATE: RunnerLiveState = {
  state: 'idle',
  countdownSec: 0,
  sessionUnfollowedCount: 0,
};

export function normalizeUsername(raw: string): string {
  return raw.trim().replace(/^@+/, '').replace(/\/+$/, '').toLowerCase();
}

/**
 * Own-property lookup for the username-keyed accounts map. "constructor", "__proto__",
 * "hasOwnProperty" … are all valid Instagram usernames; a plain `map[name]` read would return
 * Object.prototype members and `map[name] = rec` on "__proto__" would replace the prototype.
 */
export function getOwnRecord<T>(map: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

export function setOwnRecord<T>(map: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(map, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

export function buildProfileUrl(username: string): string {
  const clean = normalizeUsername(username);
  return `https://www.instagram.com/${clean}/`;
}

export function createDefaultState(): StorageStateV1 {
  return {
    schemaVersion: 1,
    theme: 'dark',
    includeFollowingInMigrate: false,
    accounts: {},
    safety: {
      accountMode: DEFAULT_SAFETY_SETTINGS.accountMode,
      unfollowTimestamps: [],
      followTimestamps: [],
      limits: {
        old_prune: { ...DEFAULT_SAFETY_SETTINGS.limits.old_prune },
        new_warmup: { ...DEFAULT_SAFETY_SETTINGS.limits.new_warmup },
      },
      automationConfig: { ...DEFAULT_AUTOMATION_CONFIG },
    },
    scraper: { ...DEFAULT_SCRAPER_STATE },
    runner: { ...DEFAULT_RUNNER_STATE },
  };
}

/**
 * Normalizes text for side-panel search: case-folds and unifies Persian/Arabic letter variants
 * (ي→ی, ك→ک), strips ZWNJ / bidi marks / harakat, so a Persian-keyboard query matches names
 * typed with Arabic code points and vice versa.
 */
export function normalizeSearchText(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[\u064a\u0649]/g, '\u06cc')
    .replace(/\u0643/g, '\u06a9')
    .replace(/[\u200c\u200d\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff\u064b-\u0652]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
