export type AccountStatus =
  | 'following'
  | 'queued_unfollow'
  | 'unfollowed_migrate'
  | 'unfollowed_dropped'
  | 'migrated_following'
  | 'migrated_requested';

export type AccountIntent = 'migrate' | 'drop';
export type AccountMode = 'old_prune' | 'new_warmup';
export type ThemeMode = 'dark' | 'light';

export interface AccountRecord {
  username: string; // lowercase normalized primary key
  displayName: string;
  avatarUrl: string;
  profileUrl: string; // https://www.instagram.com/${username}/
  isVerified: boolean;
  status: AccountStatus;
  intent: AccountIntent; // Default: 'migrate'
  extractedAt: number;
  unfollowedAt?: number;
  migratedAt?: number;
}

export interface ModeLimitConfig {
  maxPerHour: number;
  maxPerDay: number;
}

export interface AutomationConfig {
  minDelaySec: number; // 28
  maxDelaySec: number; // 58
  batchSizeBeforeBreak: number; // 12
  breakMinMinutes: number; // 5
  breakMaxMinutes: number; // 8
  profileFallback: boolean; // false
  autoResumeAfterCooldown: boolean; // true
}

export interface SafetySettings {
  accountMode: AccountMode;
  unfollowTimestamps: number[];
  followTimestamps: number[];
  limits: {
    old_prune: ModeLimitConfig; // { maxPerHour: 15, maxPerDay: 80 }
    new_warmup: ModeLimitConfig; // { maxPerHour: 10, maxPerDay: 35 }
  };
  automationConfig: AutomationConfig;
  emergencyStopReason?: string;
}

export type ScraperScrollState =
  | 'idle'
  | 'scanning'
  | 'paused'
  | 'reading_pause'
  | 'completed'
  | 'error';

export interface ScraperLiveState {
  scrollState: ScraperScrollState;
  extractedCount: number;
  sessionNewCount: number;
  stepCount: number;
  retryCount: number;
  statusText?: string;
}

export type RunnerExecState =
  | 'idle'
  | 'running'
  | 'paused'
  | 'cooldown_paused'
  | 'micro_break'
  | 'circuit_tripped';

export interface RunnerLiveState {
  state: RunnerExecState;
  currentTarget?: string;
  countdownSec: number;
  sessionUnfollowedCount: number;
  statusText?: string;
}

export interface StorageStateV1 {
  schemaVersion: 1;
  theme: ThemeMode; // default 'dark'
  activeVisitedUsername?: string;
  includeFollowingInMigrate: boolean; // default false
  accounts: Record<string, AccountRecord>;
  safety: SafetySettings;
  scraper: ScraperLiveState;
  runner: RunnerLiveState;
}

export interface ScrapedAccountInput {
  username: string;
  displayName: string;
  avatarUrl: string;
  isVerified: boolean;
}
