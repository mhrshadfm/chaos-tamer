import type { BridgeResponse } from '../types/messages';
import type {
  AccountIntent,
  AccountMode,
  AccountRecord,
  AccountStatus,
  AutomationConfig,
  ModeLimitConfig,
  RunnerLiveState,
  ScrapedAccountInput,
  ScraperLiveState,
  StorageStateV1,
  ThemeMode,
} from '../types/schema';
import {
  buildProfileUrl,
  createDefaultState,
  DEFAULT_RUNNER_STATE,
  getOwnRecord,
  setOwnRecord,
  DEFAULT_SCRAPER_STATE,
  normalizeUsername,
  STORAGE_KEY,
} from '../lib/constants';
import { validateAndNormalizeBackup } from '../lib/exporters';
import { pruneRollingTimestamps, unionRollingTimestamps } from '../lib/rateLimiter';

/**
 * Serialized Promise queue guaranteeing atomic read-modify-write cycles on chrome.storage.local.
 */
export class StorageMutex {
  private tail: Promise<void> = Promise.resolve();

  public runExclusive<T>(task: () => Promise<T> | T): Promise<T> {
    const execution = this.tail.then(() => task());
    this.tail = execution.then(
      () => undefined,
      () => undefined,
    );
    return execution;
  }
}

export const storageMutex = new StorageMutex();

// Merge precedence. `queued_unfollow` ranks like `following`: the queue is a per-device workflow
// state, so merging an old backup must not re-queue accounts the user has since un-queued.
const STATUS_PROGRESSION_RANK: Record<AccountStatus, number> = {
  following: 0,
  queued_unfollow: 0,
  unfollowed_dropped: 2,
  unfollowed_migrate: 2,
  migrated_requested: 3,
  migrated_following: 4,
};

async function loadOrInitUnlocked(): Promise<StorageStateV1> {
  const raw = await chrome.storage.local.get(STORAGE_KEY);
  const existing = raw[STORAGE_KEY] as StorageStateV1 | undefined;
  if (
    existing &&
    existing.schemaVersion === 1 &&
    typeof existing.accounts === 'object' &&
    existing.accounts !== null
  ) {
    return existing;
  }
  if (existing !== undefined) {
    // Never silently discard unreadable data: keep a copy the user can recover from.
    await chrome.storage.local.set({ [`${STORAGE_KEY}_unreadable_${Date.now()}`]: existing });
  }
  const initial = createDefaultState();
  await chrome.storage.local.set({ [STORAGE_KEY]: initial });
  return initial;
}

/**
 * Reads current StorageStateV1 inside the serialized mutex queue.
 */
export function readState(): Promise<StorageStateV1> {
  return storageMutex.runExclusive(() => loadOrInitUnlocked());
}

/**
 * Atomically reads StorageStateV1, applies synchronous or async mutations to draft,
 * persists back to chrome.storage.local, and returns the saved state.
 */
export function mutateState(
  mutator: (draft: StorageStateV1) => void | Promise<void>,
): Promise<StorageStateV1> {
  return storageMutex.runExclusive(async () => {
    const draft = await loadOrInitUnlocked();
    await mutator(draft);
    await chrome.storage.local.set({ [STORAGE_KEY]: draft });
    return draft;
  });
}

/**
 * Prunes >24h rolling timestamps on alarm ticks, writing to storage only if entries expired.
 */
export function pruneStoredTimestamps(): Promise<StorageStateV1> {
  return storageMutex.runExclusive(async () => {
    const draft = await loadOrInitUnlocked();
    const now = Date.now();
    const nextUnfollow = pruneRollingTimestamps(draft.safety.unfollowTimestamps, now);
    const nextFollow = pruneRollingTimestamps(draft.safety.followTimestamps, now);

    // Compare contents, not just lengths: clamping a future timestamp changes a value in place.
    const sameList = (a: number[], b: number[]): boolean =>
      a.length === b.length && a.every((v, i) => v === b[i]);
    if (
      !sameList(nextUnfollow, draft.safety.unfollowTimestamps) ||
      !sameList(nextFollow, draft.safety.followTimestamps)
    ) {
      draft.safety.unfollowTimestamps = nextUnfollow;
      draft.safety.followTimestamps = nextFollow;
      await chrome.storage.local.set({ [STORAGE_KEY]: draft });
    }
    return draft;
  });
}

function sanitizeModeLimitPatch(
  current: ModeLimitConfig,
  patch: Partial<ModeLimitConfig> | undefined,
): ModeLimitConfig {
  if (!patch) {
    return { ...current };
  }
  const maxPerHour =
    typeof patch.maxPerHour === 'number' && Number.isFinite(patch.maxPerHour)
      ? Math.max(1, Math.round(patch.maxPerHour))
      : current.maxPerHour;
  const maxPerDay =
    typeof patch.maxPerDay === 'number' && Number.isFinite(patch.maxPerDay)
      ? Math.max(1, Math.round(patch.maxPerDay))
      : current.maxPerDay;
  return { maxPerHour, maxPerDay };
}

function sanitizeAutomationPatch(
  current: AutomationConfig,
  patch: Partial<AutomationConfig> | undefined,
): AutomationConfig {
  if (!patch) {
    return { ...current };
  }
  const minDelaySec =
    typeof patch.minDelaySec === 'number' && Number.isFinite(patch.minDelaySec)
      ? Math.max(1, Math.round(patch.minDelaySec))
      : current.minDelaySec;
  const rawMaxDelay =
    typeof patch.maxDelaySec === 'number' && Number.isFinite(patch.maxDelaySec)
      ? Math.max(1, Math.round(patch.maxDelaySec))
      : current.maxDelaySec;
  const maxDelaySec = Math.max(minDelaySec, rawMaxDelay);

  const batchSizeBeforeBreak =
    typeof patch.batchSizeBeforeBreak === 'number' && Number.isFinite(patch.batchSizeBeforeBreak)
      ? Math.max(1, Math.round(patch.batchSizeBeforeBreak))
      : current.batchSizeBeforeBreak;

  const breakMinMinutes =
    typeof patch.breakMinMinutes === 'number' && Number.isFinite(patch.breakMinMinutes)
      ? Math.max(1, Math.round(patch.breakMinMinutes))
      : current.breakMinMinutes;
  const rawBreakMax =
    typeof patch.breakMaxMinutes === 'number' && Number.isFinite(patch.breakMaxMinutes)
      ? Math.max(1, Math.round(patch.breakMaxMinutes))
      : current.breakMaxMinutes;
  const breakMaxMinutes = Math.max(breakMinMinutes, rawBreakMax);

  return {
    minDelaySec,
    maxDelaySec,
    batchSizeBeforeBreak,
    breakMinMinutes,
    breakMaxMinutes,
    profileFallback:
      typeof patch.profileFallback === 'boolean'
        ? patch.profileFallback
        : current.profileFallback,
    autoResumeAfterCooldown:
      typeof patch.autoResumeAfterCooldown === 'boolean'
        ? patch.autoResumeAfterCooldown
        : current.autoResumeAfterCooldown,
  };
}

export function upsertAccountsBatch(accounts: ScrapedAccountInput[]): Promise<StorageStateV1> {
  return mutateState((draft) => {
    const now = Date.now();
    for (const item of accounts) {
      const username = normalizeUsername(item.username);
      if (!username) {
        continue;
      }
      const existing = getOwnRecord(draft.accounts, username);
      if (existing) {
        if (item.displayName.trim()) {
          existing.displayName = item.displayName.trim();
        }
        if (item.avatarUrl) {
          existing.avatarUrl = item.avatarUrl;
        }
        existing.isVerified = item.isVerified;
      } else {
        setOwnRecord(draft.accounts, username, {
          username,
          displayName: item.displayName.trim() || username,
          avatarUrl: item.avatarUrl || '',
          profileUrl: buildProfileUrl(username),
          isVerified: item.isVerified,
          status: 'following',
          intent: 'migrate',
          extractedAt: now,
        });
      }
    }
    draft.scraper.extractedCount = Object.keys(draft.accounts).length;
  });
}

export function setIntentBulk(
  usernames: string[],
  intent: AccountIntent,
): Promise<StorageStateV1> {
  return mutateState((draft) => {
    for (const rawName of usernames) {
      const rec = getOwnRecord(draft.accounts, normalizeUsername(rawName));
      if (!rec) {
        continue;
      }
      rec.intent = intent;
      if (rec.status === 'unfollowed_migrate' && intent === 'drop') {
        rec.status = 'unfollowed_dropped';
      } else if (rec.status === 'unfollowed_dropped' && intent === 'migrate') {
        rec.status = 'unfollowed_migrate';
      }
    }
  });
}

export function queueAccountsBulk(usernames: string[]): Promise<StorageStateV1> {
  return mutateState((draft) => {
    for (const rawName of usernames) {
      const rec = getOwnRecord(draft.accounts, normalizeUsername(rawName));
      if (rec && rec.status === 'following') {
        rec.status = 'queued_unfollow';
      }
    }
  });
}

export function unqueueAccountsBulk(usernames: string[]): Promise<StorageStateV1> {
  return mutateState((draft) => {
    for (const rawName of usernames) {
      const rec = getOwnRecord(draft.accounts, normalizeUsername(rawName));
      if (rec && rec.status === 'queued_unfollow') {
        rec.status = 'following';
      }
    }
  });
}

export function setAccountStatus(
  rawUsername: string,
  status: AccountStatus,
  recordTimestamp = false,
): Promise<BridgeResponse> {
  return storageMutex.runExclusive(async () => {
    const draft = await loadOrInitUnlocked();
    const username = normalizeUsername(rawUsername);
    const rec = getOwnRecord(draft.accounts, username);
    if (!rec) {
      return { ok: false, state: draft, error: `Account @${username} not found.` };
    }

    const now = Date.now();
    const wasMigrated = rec.status === 'migrated_following' || rec.status === 'migrated_requested';
    const isMigrated = status === 'migrated_following' || status === 'migrated_requested';
    if (wasMigrated && !isMigrated && typeof rec.migratedAt === 'number') {
      // Undoing a "Done/Followed" mark: give back the warm-up slot it consumed, otherwise
      // toggling Done on/off keeps inflating the follow gauge.
      const undoneTs = rec.migratedAt;
      const idx = draft.safety.followTimestamps.indexOf(undoneTs);
      if (idx >= 0) {
        draft.safety.followTimestamps = draft.safety.followTimestamps.filter((_, i) => i !== idx);
      }
    }
    rec.status = status;

    if (status === 'unfollowed_migrate') {
      rec.intent = 'migrate';
      rec.unfollowedAt = rec.unfollowedAt ?? now;
      delete rec.migratedAt;
      if (recordTimestamp) {
        draft.safety.unfollowTimestamps = pruneRollingTimestamps(
          [...draft.safety.unfollowTimestamps, now],
          now,
        );
      }
    } else if (status === 'unfollowed_dropped') {
      rec.intent = 'drop';
      rec.unfollowedAt = rec.unfollowedAt ?? now;
      delete rec.migratedAt;
      if (recordTimestamp) {
        draft.safety.unfollowTimestamps = pruneRollingTimestamps(
          [...draft.safety.unfollowTimestamps, now],
          now,
        );
      }
    } else if (status === 'migrated_following' || status === 'migrated_requested') {
      rec.intent = 'migrate';
      rec.migratedAt = now;
      if (recordTimestamp) {
        draft.safety.followTimestamps = pruneRollingTimestamps(
          [...draft.safety.followTimestamps, now],
          now,
        );
      }
    } else if (status === 'following') {
      delete rec.unfollowedAt;
      delete rec.migratedAt;
    }

    await chrome.storage.local.set({ [STORAGE_KEY]: draft });
    return { ok: true, state: draft };
  });
}

export function recordUnfollowEvent(rawUsername: string): Promise<BridgeResponse> {
  return storageMutex.runExclusive(async () => {
    const draft = await loadOrInitUnlocked();
    const username = normalizeUsername(rawUsername);
    if (!username) {
      return { ok: false, state: draft, error: 'Missing username for unfollow event.' };
    }

    const now = Date.now();
    const existing = getOwnRecord(draft.accounts, username);
    if (existing) {
      existing.status =
        existing.intent === 'migrate' ? 'unfollowed_migrate' : 'unfollowed_dropped';
      existing.unfollowedAt = now;
    } else {
      setOwnRecord(draft.accounts, username, {
        username,
        displayName: username,
        avatarUrl: '',
        profileUrl: buildProfileUrl(username),
        isVerified: false,
        status: 'unfollowed_dropped',
        intent: 'drop',
        extractedAt: now,
        unfollowedAt: now,
      });
    }

    draft.safety.unfollowTimestamps = pruneRollingTimestamps(
      [...draft.safety.unfollowTimestamps, now],
      now,
    );
    draft.scraper.extractedCount = Object.keys(draft.accounts).length;

    await chrome.storage.local.set({ [STORAGE_KEY]: draft });
    return { ok: true, state: draft };
  });
}

export function recordFollowEvent(
  rawUsername: string,
  requested: boolean,
): Promise<BridgeResponse> {
  return storageMutex.runExclusive(async () => {
    const draft = await loadOrInitUnlocked();
    const username = normalizeUsername(rawUsername);
    if (!username) {
      return { ok: false, state: draft, error: 'Missing username for follow event.' };
    }

    const now = Date.now();
    const nextStatus: AccountStatus = requested ? 'migrated_requested' : 'migrated_following';
    const existing = getOwnRecord(draft.accounts, username);

    if (existing) {
      existing.status = nextStatus;
      existing.intent = 'migrate';
      existing.migratedAt = now;
    } else {
      setOwnRecord(draft.accounts, username, {
        username,
        displayName: username,
        avatarUrl: '',
        profileUrl: buildProfileUrl(username),
        isVerified: false,
        status: nextStatus,
        intent: 'migrate',
        extractedAt: now,
        migratedAt: now,
      });
    }

    draft.safety.followTimestamps = pruneRollingTimestamps(
      [...draft.safety.followTimestamps, now],
      now,
    );
    draft.scraper.extractedCount = Object.keys(draft.accounts).length;

    await chrome.storage.local.set({ [STORAGE_KEY]: draft });
    return { ok: true, state: draft };
  });
}

export function setAccountMode(mode: AccountMode): Promise<StorageStateV1> {
  return mutateState((draft) => {
    draft.safety.accountMode = mode;
  });
}

export function setTheme(theme: ThemeMode): Promise<StorageStateV1> {
  return mutateState((draft) => {
    draft.theme = theme;
  });
}

export function setIncludeFollowingMigrate(include: boolean): Promise<StorageStateV1> {
  return mutateState((draft) => {
    draft.includeFollowingInMigrate = include;
  });
}

export function updateSafetyLimits(
  limits?: Partial<{
    old_prune: Partial<ModeLimitConfig>;
    new_warmup: Partial<ModeLimitConfig>;
  }>,
  automationConfig?: Partial<AutomationConfig>,
): Promise<StorageStateV1> {
  return mutateState((draft) => {
    draft.safety.limits = {
      old_prune: sanitizeModeLimitPatch(draft.safety.limits.old_prune, limits?.old_prune),
      new_warmup: sanitizeModeLimitPatch(draft.safety.limits.new_warmup, limits?.new_warmup),
    };
    draft.safety.automationConfig = sanitizeAutomationPatch(
      draft.safety.automationConfig,
      automationConfig,
    );
  });
}

export function tripCircuitBreaker(reason: string): Promise<StorageStateV1> {
  return mutateState((draft) => {
    draft.safety.emergencyStopReason = reason;
    draft.runner = {
      ...draft.runner,
      state: 'circuit_tripped',
      countdownSec: 0,
      statusText: reason,
    };
    if (
      draft.scraper.scrollState === 'scanning' ||
      draft.scraper.scrollState === 'reading_pause'
    ) {
      draft.scraper = {
        ...draft.scraper,
        scrollState: 'paused',
        statusText: 'Paused due to emergency circuit breaker.',
      };
    }
  });
}

export function clearCircuitBreaker(): Promise<StorageStateV1> {
  return mutateState((draft) => {
    delete draft.safety.emergencyStopReason;
    if (draft.runner.state === 'circuit_tripped') {
      draft.runner = {
        ...DEFAULT_RUNNER_STATE,
        sessionUnfollowedCount: draft.runner.sessionUnfollowedCount,
      };
    }
  });
}

export function patchScraperState(patch: Partial<ScraperLiveState>): Promise<StorageStateV1> {
  return mutateState((draft) => {
    draft.scraper = { ...draft.scraper, ...patch };
  });
}

export function patchRunnerState(patch: Partial<RunnerLiveState>): Promise<StorageStateV1> {
  return mutateState((draft) => {
    const next: RunnerLiveState = { ...draft.runner, ...patch };
    // While the emergency circuit breaker is latched, a late "stopped"/"paused" patch from a
    // content-script engine (racing the broadcast stop) must not mask the trip in the UI.
    const latchedReason = draft.safety.emergencyStopReason;
    if (latchedReason && next.state !== 'circuit_tripped') {
      next.state = 'circuit_tripped';
      next.countdownSec = 0;
      next.statusText = latchedReason;
      delete next.currentTarget;
    }
    draft.runner = next;
  });
}

export function setActiveVisitedUsername(rawUsername: string): Promise<StorageStateV1> {
  return mutateState((draft) => {
    const clean = normalizeUsername(rawUsername);
    if (clean) {
      draft.activeVisitedUsername = clean;
    }
  });
}

export function importBackupData(
  raw: unknown,
  mode: 'merge' | 'replace',
): Promise<BridgeResponse> {
  const validation = validateAndNormalizeBackup(raw);
  if (!validation.valid) {
    return Promise.resolve({ ok: false, error: validation.error });
  }

  return storageMutex.runExclusive(async () => {
    const incoming = validation.state;
    const importedCount = Object.keys(incoming.accounts).length;
    const draft = await loadOrInitUnlocked();
    const now = Date.now();

    const runnerBusy =
      draft.runner.state === 'running' ||
      draft.runner.state === 'micro_break' ||
      draft.runner.state === 'cooldown_paused';
    const scraperBusy =
      draft.scraper.scrollState === 'scanning' || draft.scraper.scrollState === 'reading_pause';
    if (runnerBusy || scraperBusy) {
      return {
        ok: false,
        state: draft,
        error: 'Stop the running scan / Safe Auto-Unfollow before importing a backup.',
      };
    }

    // Rolling rate-limit history describes what THIS Instagram account really did in the last
    // 24h, so it is always unioned (even in Replace mode) — replacing it with an older backup's
    // history would silently reset the 1h/24h caps.
    const unionTimestamps = (local: number[], fromBackup: number[]): number[] =>
      unionRollingTimestamps(local, fromBackup, now);
    const mergedUnfollowTs = unionTimestamps(
      draft.safety.unfollowTimestamps,
      incoming.safety.unfollowTimestamps,
    );
    const mergedFollowTs = unionTimestamps(
      draft.safety.followTimestamps,
      incoming.safety.followTimestamps,
    );
    // Never let an import silently clear a latched emergency stop.
    const latchedReason = draft.safety.emergencyStopReason ?? incoming.safety.emergencyStopReason;

    if (mode === 'replace') {
      const replaced: StorageStateV1 = {
        ...incoming,
        safety: {
          ...incoming.safety,
          unfollowTimestamps: mergedUnfollowTs,
          followTimestamps: mergedFollowTs,
          ...(latchedReason ? { emergencyStopReason: latchedReason } : {}),
        },
        runner: latchedReason
          ? { ...DEFAULT_RUNNER_STATE, state: 'circuit_tripped', statusText: latchedReason }
          : { ...DEFAULT_RUNNER_STATE },
      };
      await chrome.storage.local.set({ [STORAGE_KEY]: replaced });
      return { ok: true, state: replaced, importedCount };
    }

    for (const [username, incRec] of Object.entries(incoming.accounts)) {
      const curRec = getOwnRecord(draft.accounts, username);
      if (!curRec) {
        setOwnRecord(draft.accounts, username, { ...incRec });
        continue;
      }

      const curRank = STATUS_PROGRESSION_RANK[curRec.status];
      const incRank = STATUS_PROGRESSION_RANK[incRec.status];
      // Strictly further along wins; on a tie the CURRENT (newer, local) record is kept so an old
      // backup can't revert recent Migrate/Drop decisions.
      const takeIncoming = incRank > curRank;
      const chosen = takeIncoming ? incRec : curRec;
      const other = takeIncoming ? curRec : incRec;
      const unfollowedAt = chosen.unfollowedAt ?? other.unfollowedAt;
      const migratedAt = chosen.migratedAt ?? other.migratedAt;

      const merged: AccountRecord = {
        username,
        displayName: curRec.displayName || incRec.displayName,
        avatarUrl: curRec.avatarUrl || incRec.avatarUrl,
        profileUrl: buildProfileUrl(username),
        isVerified: incRec.isVerified || curRec.isVerified,
        status: chosen.status,
        intent: chosen.intent,
        extractedAt: Math.min(curRec.extractedAt, incRec.extractedAt),
        ...(unfollowedAt !== undefined ? { unfollowedAt } : {}),
        ...(migratedAt !== undefined ? { migratedAt } : {}),
      };
      setOwnRecord(draft.accounts, username, merged);
    }

    draft.safety.unfollowTimestamps = mergedUnfollowTs;
    draft.safety.followTimestamps = mergedFollowTs;
    draft.scraper = {
      ...DEFAULT_SCRAPER_STATE,
      extractedCount: Object.keys(draft.accounts).length,
    };
    if (draft.runner.state !== 'circuit_tripped') {
      draft.runner = { ...DEFAULT_RUNNER_STATE };
    }

    await chrome.storage.local.set({ [STORAGE_KEY]: draft });
    return { ok: true, state: draft, importedCount };
  });
}

export function resetAllData(): Promise<StorageStateV1> {
  return storageMutex.runExclusive(async () => {
    const current = await loadOrInitUnlocked();
    const fresh = createDefaultState();
    fresh.theme = current.theme;
    await chrome.storage.local.set({ [STORAGE_KEY]: fresh });
    return fresh;
  });
}
