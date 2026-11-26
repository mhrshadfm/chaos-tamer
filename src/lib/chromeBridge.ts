import type { BridgeResponse, ExtensionMessage } from '../types/messages';
import type {
  AccountRecord,
  AccountStatus,
  AutomationConfig,
  ModeLimitConfig,
  StorageStateV1,
} from '../types/schema';
import {
  buildProfileUrl,
  createDefaultState,
  DEFAULT_RUNNER_STATE,
  DEFAULT_SCRAPER_STATE,
  normalizeUsername,
  STORAGE_KEY,
} from './constants';
import { validateAndNormalizeBackup } from './exporters';
import {
  buildSvgInitialsAvatar,
  createMockSeedState,
  generateMockScrapedBatch,
} from './mockSeed';
import {
  evaluateRateLimit,
  pruneRollingTimestamps,
  sampleTruncatedGaussianSec,
} from './rateLimiter';

export interface ChaosTamerAndroidPanelBridge {
  dispatchMessage: (messageJson: string) => string;
  getStateJson: () => string;
  saveExportFile: (filename: string, content: string, mimeType: string) => boolean;
  shareExportFile?: (filename: string, content: string, mimeType: string) => boolean;
}

declare global {
  interface Window {
    ChaosTamerAndroidPanel?: ChaosTamerAndroidPanelBridge;
    __chaosTamerNotifyNativeState?: (stateJsonOrObj: string | StorageStateV1) => void;
  }
}

/**
 * Detects whether code is running inside a real Chrome MV3 extension context
 * vs standalone Vite browser preview mode.
 */
export function isExtensionContext(): boolean {
  return typeof chrome !== 'undefined' && Boolean(chrome.runtime?.id);
}

/**
 * Detects whether the UI is hosted inside the native Chaos Tamer Android application.
 */
export function isAndroidAppContext(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.ChaosTamerAndroidPanel?.dispatchMessage === 'function'
  );
}

/**
 * True when connected to either the Chrome MV3 Service Worker or the Native Android Bridge
 * (as opposed to standalone Vite DEV MOCK preview mode).
 */
export function isLiveHostContext(): boolean {
  return isExtensionContext() || isAndroidAppContext();
}

const androidStateListeners = new Set<(state: StorageStateV1) => void>();

function ensureAndroidStatePushHook(): void {
  if (typeof window === 'undefined') {
    return;
  }
  if (typeof window.__chaosTamerNotifyNativeState === 'function') {
    return;
  }
  window.__chaosTamerNotifyNativeState = (payload: string | StorageStateV1): void => {
    try {
      const parsed: StorageStateV1 =
        typeof payload === 'string' ? (JSON.parse(payload) as StorageStateV1) : payload;
      if (parsed && parsed.schemaVersion === 1 && typeof parsed.accounts === 'object') {
        for (const listener of androidStateListeners) {
          try {
            listener(parsed);
          } catch {
            // Ignore individual listener errors
          }
        }
      }
    } catch {
      // Ignore malformed native push payloads
    }
  };
}

if (isAndroidAppContext()) {
  ensureAndroidStatePushHook();
}

// ============================================================================
// Browser Dev / Mock Bridge Runtime (used when !isExtensionContext())
// ============================================================================

type StateListener = (state: StorageStateV1) => void;

const devListeners = new Set<StateListener>();
let devStorageListenerAttached = false;
let devMutationQueue: Promise<void> = Promise.resolve();

let devScraperTimer: ReturnType<typeof setInterval> | null = null;
let devScraperTargetSteps = 6;

let devRunnerTimer: ReturnType<typeof setInterval> | null = null;

const STATUS_PROGRESSION_RANK: Record<AccountStatus, number> = {
  following: 0,
  queued_unfollow: 1,
  unfollowed_dropped: 2,
  unfollowed_migrate: 2,
  migrated_requested: 3,
  migrated_following: 4,
};

function cloneState(state: StorageStateV1): StorageStateV1 {
  return JSON.parse(JSON.stringify(state)) as StorageStateV1;
}

function runDevExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
  const next = devMutationQueue.then(() => fn());
  devMutationQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

function stopDevScraperTimer(): void {
  if (devScraperTimer !== null) {
    clearInterval(devScraperTimer);
    devScraperTimer = null;
  }
}

function stopDevRunnerTimer(): void {
  if (devRunnerTimer !== null) {
    clearInterval(devRunnerTimer);
    devRunnerTimer = null;
  }
}

function readDevStateSync(): StorageStateV1 {
  if (typeof localStorage === 'undefined') {
    return createMockSeedState();
  }
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    const seeded = createMockSeedState();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded));
    return seeded;
  }
  try {
    const parsed = JSON.parse(raw) as StorageStateV1;
    if (parsed && parsed.schemaVersion === 1 && typeof parsed.accounts === 'object') {
      return parsed;
    }
  } catch {
    // Fall through to re-seed if corrupted
  }
  const seeded = createMockSeedState();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded));
  return seeded;
}

function writeDevStateSync(state: StorageStateV1): StorageStateV1 {
  const snapshot = cloneState(state);
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  }
  for (const listener of devListeners) {
    try {
      listener(cloneState(snapshot));
    } catch {
      // Ignore individual subscriber errors
    }
  }
  return snapshot;
}

function ensureCrossTabDevSync(): void {
  if (devStorageListenerAttached || typeof window === 'undefined') {
    return;
  }
  devStorageListenerAttached = true;
  window.addEventListener('storage', (event: StorageEvent) => {
    if (event.key === STORAGE_KEY && event.newValue) {
      try {
        const parsed = JSON.parse(event.newValue) as StorageStateV1;
        if (parsed && parsed.schemaVersion === 1) {
          for (const listener of devListeners) {
            listener(cloneState(parsed));
          }
        }
      } catch {
        // Ignore malformed storage writes
      }
    }
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

function findNextQueuedUsername(state: StorageStateV1): string | undefined {
  for (const record of Object.values(state.accounts)) {
    if (record.status === 'queued_unfollow') {
      return record.username;
    }
  }
  return undefined;
}

function startDevScraperLoop(): void {
  stopDevScraperTimer();
  devScraperTimer = setInterval(() => {
    void runDevExclusive(() => {
      const draft = readDevStateSync();
      if (
        draft.scraper.scrollState !== 'scanning' &&
        draft.scraper.scrollState !== 'reading_pause'
      ) {
        stopDevScraperTimer();
        return;
      }

      const nextStep = draft.scraper.stepCount + 1;
      const existingSet = new Set(Object.keys(draft.accounts));
      const batchCount = nextStep % 2 === 0 ? 3 : 2;
      const discovered = generateMockScrapedBatch(existingSet, batchCount, nextStep);
      const now = Date.now();

      for (const item of discovered) {
        const username = normalizeUsername(item.username);
        if (!username || draft.accounts[username]) {
          continue;
        }
        draft.accounts[username] = {
          username,
          displayName: item.displayName,
          avatarUrl: item.avatarUrl,
          profileUrl: buildProfileUrl(username),
          isVerified: item.isVerified,
          status: 'following',
          intent: 'migrate',
          extractedAt: now,
        };
      }

      const totalAccounts = Object.keys(draft.accounts).length;
      const sessionNewCount = draft.scraper.sessionNewCount + discovered.length;

      if (nextStep >= devScraperTargetSteps) {
        stopDevScraperTimer();
        draft.scraper = {
          scrollState: 'completed',
          extractedCount: totalAccounts,
          sessionNewCount,
          stepCount: nextStep,
          retryCount: 0,
          statusText: `Scan complete — ${sessionNewCount} new accounts added (${totalAccounts} total).`,
        };
      } else if (nextStep === 4) {
        draft.scraper = {
          scrollState: 'reading_pause',
          extractedCount: totalAccounts,
          sessionNewCount,
          stepCount: nextStep,
          retryCount: 0,
          statusText: 'Humanized reading pause to prevent rate-limiting...',
        };
      } else {
        draft.scraper = {
          scrollState: 'scanning',
          extractedCount: totalAccounts,
          sessionNewCount,
          stepCount: nextStep,
          retryCount: 0,
          statusText: `Scanning Following modal • +${sessionNewCount} new this session`,
        };
      }

      writeDevStateSync(draft);
    });
  }, 1400);
}

function startDevRunnerLoop(): void {
  stopDevRunnerTimer();
  devRunnerTimer = setInterval(() => {
    void runDevExclusive(() => {
      const draft = readDevStateSync();
      const runnerState = draft.runner.state;

      if (
        runnerState !== 'running' &&
        runnerState !== 'cooldown_paused' &&
        runnerState !== 'micro_break'
      ) {
        stopDevRunnerTimer();
        return;
      }

      if (draft.safety.emergencyStopReason) {
        stopDevRunnerTimer();
        draft.runner = {
          ...draft.runner,
          state: 'circuit_tripped',
          countdownSec: 0,
          statusText: draft.safety.emergencyStopReason,
        };
        writeDevStateSync(draft);
        return;
      }

      const now = Date.now();
      const remaining = Math.max(0, draft.runner.countdownSec - 1);

      if (remaining > 0) {
        const targetLabel = draft.runner.currentTarget ? `@${draft.runner.currentTarget}` : 'next';
        let statusText = `Next unfollow (${targetLabel}) in ${remaining}s`;
        if (runnerState === 'cooldown_paused') {
          statusText = `Rate-limit cooldown — resuming in ${remaining}s`;
        } else if (runnerState === 'micro_break') {
          statusText = `Batch micro-break — resuming in ${remaining}s`;
        }
        draft.runner = {
          ...draft.runner,
          countdownSec: remaining,
          statusText,
        };
        writeDevStateSync(draft);
        return;
      }

      // Countdown reached 0
      if (runnerState === 'cooldown_paused') {
        const snap = evaluateRateLimit(draft.safety, 'old_prune', now);
        if (!snap.canAct) {
          const waitSec = Math.max(1, Math.ceil(snap.nextSlotAvailableInMs / 1000));
          draft.runner = {
            ...draft.runner,
            state: 'cooldown_paused',
            countdownSec: waitSec,
            statusText: `Rate-limit cooldown — resuming in ${waitSec}s`,
          };
          writeDevStateSync(draft);
          return;
        }
        if (!draft.safety.automationConfig.autoResumeAfterCooldown) {
          stopDevRunnerTimer();
          draft.runner = {
            ...draft.runner,
            state: 'paused',
            countdownSec: 0,
            statusText: 'Cooldown finished — click Resume to continue.',
          };
          writeDevStateSync(draft);
          return;
        }
        const nextUser = findNextQueuedUsername(draft);
        if (!nextUser) {
          stopDevRunnerTimer();
          draft.runner = {
            ...draft.runner,
            state: 'idle',
            currentTarget: undefined,
            countdownSec: 0,
            statusText: 'Queue finished.',
          };
          writeDevStateSync(draft);
          return;
        }
        const delay = sampleTruncatedGaussianSec(
          draft.safety.automationConfig.minDelaySec,
          draft.safety.automationConfig.maxDelaySec,
        );
        draft.runner = {
          ...draft.runner,
          state: 'running',
          currentTarget: nextUser,
          countdownSec: delay,
          statusText: `Next unfollow (@${nextUser}) in ${delay}s`,
        };
        writeDevStateSync(draft);
        return;
      }

      if (runnerState === 'micro_break') {
        const nextUser = findNextQueuedUsername(draft);
        if (!nextUser) {
          stopDevRunnerTimer();
          draft.runner = {
            ...draft.runner,
            state: 'idle',
            currentTarget: undefined,
            countdownSec: 0,
            statusText: 'Queue finished.',
          };
          writeDevStateSync(draft);
          return;
        }
        const delay = sampleTruncatedGaussianSec(
          draft.safety.automationConfig.minDelaySec,
          draft.safety.automationConfig.maxDelaySec,
        );
        draft.runner = {
          ...draft.runner,
          state: 'running',
          currentTarget: nextUser,
          countdownSec: delay,
          statusText: `Next unfollow (@${nextUser}) in ${delay}s`,
        };
        writeDevStateSync(draft);
        return;
      }

      // runnerState === 'running' -> commit current target unfollow!
      const currentTarget = draft.runner.currentTarget ?? findNextQueuedUsername(draft);
      let sessionCount = draft.runner.sessionUnfollowedCount;

      if (currentTarget) {
        const targetRec = draft.accounts[currentTarget];
        if (targetRec && targetRec.status === 'queued_unfollow') {
          targetRec.status =
            targetRec.intent === 'migrate' ? 'unfollowed_migrate' : 'unfollowed_dropped';
          targetRec.unfollowedAt = now;
          draft.safety.unfollowTimestamps = pruneRollingTimestamps(
            [...draft.safety.unfollowTimestamps, now],
            now,
          );
          sessionCount += 1;
        }
      }

      const nextTarget = findNextQueuedUsername(draft);
      if (!nextTarget) {
        stopDevRunnerTimer();
        draft.runner = {
          state: 'idle',
          currentTarget: undefined,
          countdownSec: 0,
          sessionUnfollowedCount: sessionCount,
          statusText: `All queued accounts unfollowed (${sessionCount} this session).`,
        };
        writeDevStateSync(draft);
        return;
      }

      const rateSnap = evaluateRateLimit(draft.safety, 'old_prune', now);
      if (!rateSnap.canAct) {
        const waitSec = Math.max(1, Math.ceil(rateSnap.nextSlotAvailableInMs / 1000));
        draft.runner = {
          state: 'cooldown_paused',
          currentTarget: nextTarget,
          countdownSec: waitSec,
          sessionUnfollowedCount: sessionCount,
          statusText: `Rate limit reached — cooling down (${rateSnap.cooldownFormatted}).`,
        };
        writeDevStateSync(draft);
        return;
      }

      const autoCfg = draft.safety.automationConfig;
      if (sessionCount > 0 && sessionCount % autoCfg.batchSizeBeforeBreak === 0) {
        const breakSec = sampleTruncatedGaussianSec(
          autoCfg.breakMinMinutes * 60,
          autoCfg.breakMaxMinutes * 60,
        );
        draft.runner = {
          state: 'micro_break',
          currentTarget: nextTarget,
          countdownSec: breakSec,
          sessionUnfollowedCount: sessionCount,
          statusText: `Batch micro-break (${sessionCount} unfollowed) — ${breakSec}s remaining`,
        };
        writeDevStateSync(draft);
        return;
      }

      const nextDelay = sampleTruncatedGaussianSec(autoCfg.minDelaySec, autoCfg.maxDelaySec);
      draft.runner = {
        state: 'running',
        currentTarget: nextTarget,
        countdownSec: nextDelay,
        sessionUnfollowedCount: sessionCount,
        statusText: `Next unfollow (@${nextTarget}) in ${nextDelay}s`,
      };
      writeDevStateSync(draft);
    });
  }, 1000);
}

function handleDevMessage(msg: ExtensionMessage): Promise<BridgeResponse> {
  return runDevExclusive<BridgeResponse>(() => {
    const draft = readDevStateSync();
    const now = Date.now();

    switch (msg.type) {
      case 'GET_STATE': {
        return { ok: true, state: cloneState(draft) };
      }

      case 'UPSERT_ACCOUNTS_BATCH': {
        for (const item of msg.accounts) {
          const username = normalizeUsername(item.username);
          if (!username) {
            continue;
          }
          const existing = draft.accounts[username];
          if (existing) {
            if (item.displayName.trim()) {
              existing.displayName = item.displayName.trim();
            }
            if (item.avatarUrl) {
              existing.avatarUrl = item.avatarUrl;
            }
            existing.isVerified = item.isVerified;
          } else {
            draft.accounts[username] = {
              username,
              displayName: item.displayName.trim() || username,
              avatarUrl: item.avatarUrl || buildSvgInitialsAvatar(item.displayName || username, 7),
              profileUrl: buildProfileUrl(username),
              isVerified: item.isVerified,
              status: 'following',
              intent: 'migrate',
              extractedAt: now,
            };
          }
        }
        draft.scraper.extractedCount = Object.keys(draft.accounts).length;
        return { ok: true, state: writeDevStateSync(draft) };
      }

      case 'SET_INTENT_BULK': {
        for (const rawName of msg.usernames) {
          const rec = draft.accounts[normalizeUsername(rawName)];
          if (!rec) {
            continue;
          }
          rec.intent = msg.intent;
          if (rec.status === 'unfollowed_migrate' && msg.intent === 'drop') {
            rec.status = 'unfollowed_dropped';
          } else if (rec.status === 'unfollowed_dropped' && msg.intent === 'migrate') {
            rec.status = 'unfollowed_migrate';
          }
        }
        return { ok: true, state: writeDevStateSync(draft) };
      }

      case 'QUEUE_ACCOUNTS_BULK': {
        for (const rawName of msg.usernames) {
          const rec = draft.accounts[normalizeUsername(rawName)];
          if (rec && rec.status === 'following') {
            rec.status = 'queued_unfollow';
          }
        }
        return { ok: true, state: writeDevStateSync(draft) };
      }

      case 'UNQUEUE_ACCOUNTS_BULK': {
        for (const rawName of msg.usernames) {
          const rec = draft.accounts[normalizeUsername(rawName)];
          if (rec && rec.status === 'queued_unfollow') {
            rec.status = 'following';
          }
        }
        return { ok: true, state: writeDevStateSync(draft) };
      }

      case 'SET_ACCOUNT_STATUS': {
        const username = normalizeUsername(msg.username);
        const rec = draft.accounts[username];
        if (!rec) {
          return { ok: false, state: cloneState(draft), error: `Account @${username} not found.` };
        }
        rec.status = msg.status;
        if (msg.status === 'unfollowed_migrate') {
          rec.intent = 'migrate';
          rec.unfollowedAt = rec.unfollowedAt ?? now;
          delete rec.migratedAt;
          if (msg.recordTimestamp) {
            draft.safety.unfollowTimestamps = pruneRollingTimestamps(
              [...draft.safety.unfollowTimestamps, now],
              now,
            );
          }
        } else if (msg.status === 'unfollowed_dropped') {
          rec.intent = 'drop';
          rec.unfollowedAt = rec.unfollowedAt ?? now;
          delete rec.migratedAt;
          if (msg.recordTimestamp) {
            draft.safety.unfollowTimestamps = pruneRollingTimestamps(
              [...draft.safety.unfollowTimestamps, now],
              now,
            );
          }
        } else if (msg.status === 'migrated_following' || msg.status === 'migrated_requested') {
          rec.intent = 'migrate';
          rec.migratedAt = now;
          if (msg.recordTimestamp) {
            draft.safety.followTimestamps = pruneRollingTimestamps(
              [...draft.safety.followTimestamps, now],
              now,
            );
          }
        } else if (msg.status === 'following') {
          delete rec.unfollowedAt;
          delete rec.migratedAt;
        }
        return { ok: true, state: writeDevStateSync(draft) };
      }

      case 'PASSIVE_UNFOLLOW_DETECTED':
      case 'AUTO_UNFOLLOW_COMMITTED': {
        const username = normalizeUsername(msg.username);
        if (!username) {
          return { ok: false, state: cloneState(draft), error: 'Missing username.' };
        }
        const existing = draft.accounts[username];
        if (existing) {
          existing.status =
            existing.intent === 'migrate' ? 'unfollowed_migrate' : 'unfollowed_dropped';
          existing.unfollowedAt = now;
        } else {
          draft.accounts[username] = {
            username,
            displayName: username,
            avatarUrl: buildSvgInitialsAvatar(username, 11),
            profileUrl: buildProfileUrl(username),
            isVerified: false,
            status: 'unfollowed_dropped',
            intent: 'drop',
            extractedAt: now,
            unfollowedAt: now,
          };
        }
        draft.safety.unfollowTimestamps = pruneRollingTimestamps(
          [...draft.safety.unfollowTimestamps, now],
          now,
        );
        return { ok: true, state: writeDevStateSync(draft) };
      }

      case 'PASSIVE_FOLLOW_DETECTED': {
        const username = normalizeUsername(msg.username);
        if (!username) {
          return { ok: false, state: cloneState(draft), error: 'Missing username.' };
        }
        const targetStatus: AccountStatus = msg.requested
          ? 'migrated_requested'
          : 'migrated_following';
        const existing = draft.accounts[username];
        if (existing) {
          existing.status = targetStatus;
          existing.intent = 'migrate';
          existing.migratedAt = now;
        } else {
          draft.accounts[username] = {
            username,
            displayName: username,
            avatarUrl: buildSvgInitialsAvatar(username, 19),
            profileUrl: buildProfileUrl(username),
            isVerified: false,
            status: targetStatus,
            intent: 'migrate',
            extractedAt: now,
            migratedAt: now,
          };
        }
        draft.safety.followTimestamps = pruneRollingTimestamps(
          [...draft.safety.followTimestamps, now],
          now,
        );
        return { ok: true, state: writeDevStateSync(draft) };
      }

      case 'SET_ACCOUNT_MODE': {
        draft.safety.accountMode = msg.mode;
        return { ok: true, state: writeDevStateSync(draft) };
      }

      case 'SET_THEME': {
        draft.theme = msg.theme;
        return { ok: true, state: writeDevStateSync(draft) };
      }

      case 'SET_INCLUDE_FOLLOWING_MIGRATE': {
        draft.includeFollowingInMigrate = msg.include;
        return { ok: true, state: writeDevStateSync(draft) };
      }

      case 'UPDATE_SAFETY_LIMITS': {
        draft.safety.limits = {
          old_prune: sanitizeModeLimitPatch(draft.safety.limits.old_prune, msg.limits?.old_prune),
          new_warmup: sanitizeModeLimitPatch(
            draft.safety.limits.new_warmup,
            msg.limits?.new_warmup,
          ),
        };
        draft.safety.automationConfig = sanitizeAutomationPatch(
          draft.safety.automationConfig,
          msg.automationConfig,
        );
        return { ok: true, state: writeDevStateSync(draft) };
      }

      case 'TRIP_CIRCUIT_BREAKER': {
        stopDevScraperTimer();
        stopDevRunnerTimer();
        draft.safety.emergencyStopReason = msg.reason;
        draft.runner = {
          ...draft.runner,
          state: 'circuit_tripped',
          countdownSec: 0,
          statusText: msg.reason,
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
        return { ok: true, state: writeDevStateSync(draft) };
      }

      case 'CLEAR_CIRCUIT_BREAKER': {
        delete draft.safety.emergencyStopReason;
        if (draft.runner.state === 'circuit_tripped') {
          draft.runner = {
            ...DEFAULT_RUNNER_STATE,
            sessionUnfollowedCount: draft.runner.sessionUnfollowedCount,
          };
        }
        return { ok: true, state: writeDevStateSync(draft) };
      }

      case 'SCRAPER_COMMAND': {
        if (msg.action === 'start') {
          if (draft.safety.emergencyStopReason) {
            return {
              ok: false,
              state: cloneState(draft),
              error: 'Circuit breaker is active. Clear the lock before scanning.',
            };
          }
          devScraperTargetSteps = 6;
          draft.scraper = {
            scrollState: 'scanning',
            extractedCount: Object.keys(draft.accounts).length,
            sessionNewCount: 0,
            stepCount: 0,
            retryCount: 0,
            statusText: 'Scanning Following modal (dev simulation)...',
          };
          const saved = writeDevStateSync(draft);
          startDevScraperLoop();
          return { ok: true, state: saved };
        }

        if (msg.action === 'pause') {
          stopDevScraperTimer();
          draft.scraper = {
            ...draft.scraper,
            scrollState: 'paused',
            statusText: 'Scan paused.',
          };
          return { ok: true, state: writeDevStateSync(draft) };
        }

        if (msg.action === 'resume') {
          if (draft.safety.emergencyStopReason) {
            return {
              ok: false,
              state: cloneState(draft),
              error: 'Circuit breaker is active. Clear the lock before resuming.',
            };
          }
          if (draft.scraper.stepCount >= devScraperTargetSteps) {
            devScraperTargetSteps = draft.scraper.stepCount + 4;
          }
          draft.scraper = {
            ...draft.scraper,
            scrollState: 'scanning',
            statusText: 'Resumed Following modal scan...',
          };
          const saved = writeDevStateSync(draft);
          startDevScraperLoop();
          return { ok: true, state: saved };
        }

        // action === 'stop'
        stopDevScraperTimer();
        draft.scraper = {
          ...draft.scraper,
          scrollState: 'idle',
          statusText: 'Scan stopped.',
        };
        return { ok: true, state: writeDevStateSync(draft) };
      }

      case 'SCRAPER_STATE_PATCH': {
        draft.scraper = { ...draft.scraper, ...msg.patch };
        return { ok: true, state: writeDevStateSync(draft) };
      }

      case 'RUNNER_COMMAND': {
        if (msg.action === 'start') {
          if (draft.safety.emergencyStopReason) {
            return {
              ok: false,
              state: cloneState(draft),
              error: 'Circuit breaker is active. Acknowledge and clear the lock first.',
            };
          }

          const firstTarget = findNextQueuedUsername(draft);
          if (!firstTarget) {
            stopDevRunnerTimer();
            draft.runner = {
              state: 'idle',
              currentTarget: undefined,
              countdownSec: 0,
              sessionUnfollowedCount: 0,
              statusText: 'Unfollow queue is empty.',
            };
            return { ok: true, state: writeDevStateSync(draft) };
          }

          const snap = evaluateRateLimit(draft.safety, 'old_prune', now);
          if (!snap.canAct) {
            const waitSec = Math.max(1, Math.ceil(snap.nextSlotAvailableInMs / 1000));
            draft.runner = {
              state: 'cooldown_paused',
              currentTarget: firstTarget,
              countdownSec: waitSec,
              sessionUnfollowedCount: 0,
              statusText: `Rate limit active — cooling down (${snap.cooldownFormatted}).`,
            };
            const saved = writeDevStateSync(draft);
            startDevRunnerLoop();
            return { ok: true, state: saved };
          }

          // Start first item with a crisp 4s preview countdown, then Gaussian 28-58s between items
          draft.runner = {
            state: 'running',
            currentTarget: firstTarget,
            countdownSec: 4,
            sessionUnfollowedCount: 0,
            statusText: `Next unfollow (@${firstTarget}) in 4s`,
          };
          const saved = writeDevStateSync(draft);
          startDevRunnerLoop();
          return { ok: true, state: saved };
        }

        if (msg.action === 'pause') {
          stopDevRunnerTimer();
          draft.runner = {
            ...draft.runner,
            state: 'paused',
            statusText: 'Auto-unfollow paused.',
          };
          return { ok: true, state: writeDevStateSync(draft) };
        }

        if (msg.action === 'resume') {
          if (draft.safety.emergencyStopReason) {
            return {
              ok: false,
              state: cloneState(draft),
              error: 'Circuit breaker is active. Clear the lock before resuming.',
            };
          }
          const target = draft.runner.currentTarget ?? findNextQueuedUsername(draft);
          if (!target) {
            stopDevRunnerTimer();
            draft.runner = {
              ...draft.runner,
              state: 'idle',
              currentTarget: undefined,
              countdownSec: 0,
              statusText: 'Unfollow queue is empty.',
            };
            return { ok: true, state: writeDevStateSync(draft) };
          }
          const resumeSec = draft.runner.countdownSec > 0 ? draft.runner.countdownSec : 4;
          draft.runner = {
            ...draft.runner,
            state: 'running',
            currentTarget: target,
            countdownSec: resumeSec,
            statusText: `Next unfollow (@${target}) in ${resumeSec}s`,
          };
          const saved = writeDevStateSync(draft);
          startDevRunnerLoop();
          return { ok: true, state: saved };
        }

        // action === 'stop'
        stopDevRunnerTimer();
        draft.runner = {
          state: 'idle',
          currentTarget: undefined,
          countdownSec: 0,
          sessionUnfollowedCount: draft.runner.sessionUnfollowedCount,
          statusText: 'Auto-unfollow stopped.',
        };
        return { ok: true, state: writeDevStateSync(draft) };
      }

      case 'RUNNER_STATE_PATCH': {
        draft.runner = { ...draft.runner, ...msg.patch };
        return { ok: true, state: writeDevStateSync(draft) };
      }

      case 'OPEN_PROFILE_TAB': {
        const username = normalizeUsername(msg.username);
        if (!username) {
          return { ok: false, state: cloneState(draft), error: 'Invalid profile username.' };
        }
        draft.activeVisitedUsername = username;
        return { ok: true, state: writeDevStateSync(draft) };
      }

      case 'IMPORT_BACKUP': {
        const validation = validateAndNormalizeBackup(msg.data);
        if (!validation.valid) {
          return { ok: false, state: cloneState(draft), error: validation.error };
        }

        stopDevScraperTimer();
        stopDevRunnerTimer();

        const incoming = validation.state;
        const importedCount = Object.keys(incoming.accounts).length;

        if (msg.mode === 'replace') {
          return {
            ok: true,
            state: writeDevStateSync(incoming),
            importedCount,
          };
        }

        // Merge mode
        for (const [username, incRec] of Object.entries(incoming.accounts)) {
          const curRec = draft.accounts[username];
          if (!curRec) {
            draft.accounts[username] = { ...incRec };
            continue;
          }
          const curRank = STATUS_PROGRESSION_RANK[curRec.status];
          const incRank = STATUS_PROGRESSION_RANK[incRec.status];
          const chosenStatus = incRank >= curRank ? incRec.status : curRec.status;
          const chosenIntent = incRank >= curRank ? incRec.intent : curRec.intent;
          const unfollowedAt = incRec.unfollowedAt ?? curRec.unfollowedAt;
          const migratedAt = incRec.migratedAt ?? curRec.migratedAt;

          const merged: AccountRecord = {
            username,
            displayName: incRec.displayName || curRec.displayName,
            avatarUrl: incRec.avatarUrl || curRec.avatarUrl,
            profileUrl: incRec.profileUrl || curRec.profileUrl,
            isVerified: incRec.isVerified || curRec.isVerified,
            status: chosenStatus,
            intent: chosenIntent,
            extractedAt: Math.min(curRec.extractedAt, incRec.extractedAt),
            ...(unfollowedAt !== undefined ? { unfollowedAt } : {}),
            ...(migratedAt !== undefined ? { migratedAt } : {}),
          };
          draft.accounts[username] = merged;
        }

        draft.safety.unfollowTimestamps = pruneRollingTimestamps(
          Array.from(
            new Set([...draft.safety.unfollowTimestamps, ...incoming.safety.unfollowTimestamps]),
          ),
          now,
        );
        draft.safety.followTimestamps = pruneRollingTimestamps(
          Array.from(
            new Set([...draft.safety.followTimestamps, ...incoming.safety.followTimestamps]),
          ),
          now,
        );
        draft.scraper = {
          ...DEFAULT_SCRAPER_STATE,
          extractedCount: Object.keys(draft.accounts).length,
        };
        draft.runner = { ...DEFAULT_RUNNER_STATE };

        return {
          ok: true,
          state: writeDevStateSync(draft),
          importedCount,
        };
      }

      case 'RESET_ALL_DATA': {
        stopDevScraperTimer();
        stopDevRunnerTimer();
        const resetState = createDefaultState();
        resetState.theme = draft.theme;
        return { ok: true, state: writeDevStateSync(resetState) };
      }
    }
  });
}

// ============================================================================
// Unified Public Bridge API
// ============================================================================

/**
 * Sends a typed ExtensionMessage to the MV3 Background Service Worker, Native Android Bridge,
 * or Dev Mock Bridge.
 */
export async function sendExtensionMessage(msg: ExtensionMessage): Promise<BridgeResponse> {
  if (isAndroidAppContext()) {
    try {
      const rawJson = window.ChaosTamerAndroidPanel!.dispatchMessage(JSON.stringify(msg));
      if (!rawJson) {
        return { ok: false, error: 'Empty response from Chaos Tamer Android host.' };
      }
      const parsed = JSON.parse(rawJson) as BridgeResponse;
      return parsed;
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Android bridge message failed.',
      };
    }
  }

  if (!isExtensionContext()) {
    return handleDevMessage(msg);
  }

  try {
    const response = (await chrome.runtime.sendMessage(msg)) as BridgeResponse | undefined;
    if (!response) {
      return { ok: false, error: 'No response received from Chaos Tamer service worker.' };
    }
    return response;
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Extension message failed.',
    };
  }
}

/**
 * Reads the current StorageStateV1 from chrome.storage.local, Native Android Store, or Dev Mock localStorage.
 */
export async function getStorageState(): Promise<StorageStateV1> {
  if (isAndroidAppContext()) {
    try {
      const rawJson = window.ChaosTamerAndroidPanel!.getStateJson();
      if (rawJson) {
        const parsed = JSON.parse(rawJson) as StorageStateV1;
        if (parsed && parsed.schemaVersion === 1 && typeof parsed.accounts === 'object') {
          return parsed;
        }
      }
      const res = await sendExtensionMessage({ type: 'GET_STATE' });
      return res.state ?? createDefaultState();
    } catch {
      return createDefaultState();
    }
  }

  if (!isExtensionContext()) {
    return cloneState(readDevStateSync());
  }

  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const existing = stored[STORAGE_KEY] as StorageStateV1 | undefined;
    if (existing && existing.schemaVersion === 1) {
      return existing;
    }
    const res = await sendExtensionMessage({ type: 'GET_STATE' });
    return res.state ?? createDefaultState();
  } catch {
    return createDefaultState();
  }
}

/**
 * Subscribes to live atomic StorageStateV1 updates and returns an unsubscribe cleanup function.
 */
export function subscribeStorageState(listener: (state: StorageStateV1) => void): () => void {
  if (isAndroidAppContext()) {
    ensureAndroidStatePushHook();
    androidStateListeners.add(listener);
    return () => {
      androidStateListeners.delete(listener);
    };
  }

  if (!isExtensionContext()) {
    ensureCrossTabDevSync();
    devListeners.add(listener);
    return () => {
      devListeners.delete(listener);
    };
  }

  const handleStorageChanged = (
    changes: { [key: string]: chrome.storage.StorageChange },
    areaName: string,
  ): void => {
    if (areaName !== 'local') {
      return;
    }
    const nextValue = changes[STORAGE_KEY]?.newValue as StorageStateV1 | undefined;
    if (nextValue && nextValue.schemaVersion === 1) {
      listener(nextValue);
    }
  };

  chrome.storage.onChanged.addListener(handleStorageChanged);
  return () => {
    chrome.storage.onChanged.removeListener(handleStorageChanged);
  };
}
