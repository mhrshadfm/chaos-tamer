import type {
  AccountIntent,
  AccountMode,
  AccountStatus,
  AutomationConfig,
  ModeLimitConfig,
  RunnerLiveState,
  ScrapedAccountInput,
  ScraperLiveState,
  StorageStateV1,
  ThemeMode,
} from './schema';

export type ExtensionMessage =
  | { type: 'GET_STATE' }
  | { type: 'UPSERT_ACCOUNTS_BATCH'; accounts: ScrapedAccountInput[] }
  | { type: 'SET_INTENT_BULK'; usernames: string[]; intent: AccountIntent }
  | { type: 'QUEUE_ACCOUNTS_BULK'; usernames: string[] }
  | { type: 'UNQUEUE_ACCOUNTS_BULK'; usernames: string[] }
  | {
      type: 'SET_ACCOUNT_STATUS';
      username: string;
      status: AccountStatus;
      recordTimestamp?: boolean;
    }
  | { type: 'PASSIVE_UNFOLLOW_DETECTED'; username: string }
  | { type: 'PASSIVE_FOLLOW_DETECTED'; username: string; requested: boolean }
  | { type: 'AUTO_UNFOLLOW_COMMITTED'; username: string }
  | { type: 'SET_ACCOUNT_MODE'; mode: AccountMode }
  | { type: 'SET_THEME'; theme: ThemeMode }
  | { type: 'SET_INCLUDE_FOLLOWING_MIGRATE'; include: boolean }
  | {
      type: 'UPDATE_SAFETY_LIMITS';
      limits?: Partial<{
        old_prune: Partial<ModeLimitConfig>;
        new_warmup: Partial<ModeLimitConfig>;
      }>;
      automationConfig?: Partial<AutomationConfig>;
    }
  | { type: 'TRIP_CIRCUIT_BREAKER'; reason: string }
  | { type: 'CLEAR_CIRCUIT_BREAKER' }
  | { type: 'SCRAPER_COMMAND'; action: 'start' | 'pause' | 'resume' | 'stop' }
  | { type: 'SCRAPER_STATE_PATCH'; patch: Partial<ScraperLiveState> }
  | { type: 'RUNNER_COMMAND'; action: 'start' | 'pause' | 'resume' | 'stop' }
  | { type: 'RUNNER_STATE_PATCH'; patch: Partial<RunnerLiveState> }
  | { type: 'OPEN_PROFILE_TAB'; username: string; background?: boolean }
  | { type: 'IMPORT_BACKUP'; data: unknown; mode: 'merge' | 'replace' }
  | { type: 'RESET_ALL_DATA' };

export type ContentTabMessage =
  | { type: 'CONTENT_SCRAPER_CONTROL'; action: 'start' | 'pause' | 'resume' | 'stop' }
  | { type: 'CONTENT_RUNNER_CONTROL'; action: 'start' | 'pause' | 'resume' | 'stop' };

export interface BridgeResponse {
  ok: boolean;
  state?: StorageStateV1;
  error?: string;
  importedCount?: number;
}
