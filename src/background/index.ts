import type {
  BridgeResponse,
  ContentTabMessage,
  ExtensionMessage,
} from '../types/messages';
import { buildProfileUrl, normalizeUsername } from '../lib/constants';
import {
  clearCircuitBreaker,
  importBackupData,
  patchRunnerState,
  patchScraperState,
  pruneStoredTimestamps,
  queueAccountsBulk,
  readState,
  recordFollowEvent,
  recordUnfollowEvent,
  resetAllData,
  setAccountMode,
  setAccountStatus,
  setActiveVisitedUsername,
  setIncludeFollowingMigrate,
  setIntentBulk,
  setTheme,
  tripCircuitBreaker,
  unqueueAccountsBulk,
  updateSafetyLimits,
  upsertAccountsBatch,
} from './store';

const PRUNE_ALARM_NAME = 'chaos-tamer-prune';
const INSTAGRAM_MATCH_PATTERN = 'https://www.instagram.com/*';
const USERNAME_HANDLE_REGEX = /^[a-z0-9._]{1,30}$/;

function configureSidePanelBehavior(): void {
  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {
      // Ignore on unsupported Chromium variants
    });
  }
}

function schedulePruneAlarm(): void {
  chrome.alarms.create(PRUNE_ALARM_NAME, { periodInMinutes: 5 });
}

chrome.runtime.onInstalled.addListener(() => {
  configureSidePanelBehavior();
  schedulePruneAlarm();
  void readState();
});

chrome.runtime.onStartup.addListener(() => {
  configureSidePanelBehavior();
  schedulePruneAlarm();
});

configureSidePanelBehavior();

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PRUNE_ALARM_NAME) {
    void pruneStoredTimestamps();
  }
});

/**
 * Finds the best open https://www.instagram.com/* tab, preferring an active tab
 * in the last-focused window, then any active IG tab, then the most recently accessed IG tab.
 */
async function findTargetInstagramTab(): Promise<chrome.tabs.Tab | undefined> {
  const igTabs = await chrome.tabs.query({ url: INSTAGRAM_MATCH_PATTERN });
  const validTabs = igTabs.filter((tab) => typeof tab.id === 'number');
  if (validTabs.length === 0) {
    return undefined;
  }

  try {
    const lastFocusedWindow = await chrome.windows.getLastFocused();
    if (lastFocusedWindow?.id !== undefined) {
      const activeInFocused = validTabs.find(
        (tab) => tab.windowId === lastFocusedWindow.id && tab.active,
      );
      if (activeInFocused) {
        return activeInFocused;
      }
    }
  } catch {
    // Fallback to tab-level heuristics
  }

  const anyActive = validTabs.find((tab) => tab.active);
  if (anyActive) {
    return anyActive;
  }

  validTabs.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
  return validTabs[0];
}

/**
 * Delivers a halting control message (stop / pause) to EVERY open Instagram tab.
 * A scan or auto-unfollow run lives in whichever tab it was started from, which is not
 * necessarily the tab that is active when the user later presses Stop / Pause.
 */
async function broadcastToAllInstagramTabs(controlMsg: ContentTabMessage): Promise<void> {
  let igTabs: chrome.tabs.Tab[] = [];
  try {
    igTabs = await chrome.tabs.query({ url: INSTAGRAM_MATCH_PATTERN });
  } catch {
    return;
  }
  await Promise.all(
    igTabs
      .filter((tab) => typeof tab.id === 'number')
      .map((tab) => chrome.tabs.sendMessage(tab.id as number, controlMsg).catch(() => undefined)),
  );
}

async function forwardControlToInstagramTab(
  controlMsg: ContentTabMessage,
): Promise<BridgeResponse> {
  const currentState = await readState();

  if (
    (controlMsg.action === 'start' || controlMsg.action === 'resume') &&
    currentState.safety.emergencyStopReason
  ) {
    return {
      ok: false,
      state: currentState,
      error: 'Emergency circuit breaker is active. Acknowledge and clear the lock first.',
    };
  }

  if (controlMsg.action === 'stop') {
    const nextState =
      controlMsg.type === 'CONTENT_SCRAPER_CONTROL'
        ? await patchScraperState({ scrollState: 'idle', statusText: 'Stopped.' })
        : await patchRunnerState({
            state: 'idle',
            currentTarget: undefined,
            countdownSec: 0,
            statusText: 'Stopped.',
          });
    await broadcastToAllInstagramTabs(controlMsg);
    return { ok: true, state: nextState };
  }

  if (controlMsg.action === 'pause') {
    const nextState =
      controlMsg.type === 'CONTENT_SCRAPER_CONTROL'
        ? await patchScraperState({
            scrollState: 'paused',
            statusText: 'Paused. Tap Resume to continue scanning.',
          })
        : await patchRunnerState({
            state: 'paused',
            countdownSec: 0,
            statusText: 'Paused. Tap Resume when ready.',
          });
    await broadcastToAllInstagramTabs(controlMsg);
    return { ok: true, state: nextState };
  }

  const tab = await findTargetInstagramTab();
  if (!tab || tab.id === undefined) {
    return {
      ok: false,
      state: currentState,
      error: 'No open Instagram tab found. Open https://www.instagram.com/ first.',
    };
  }

  try {
    await chrome.tabs.sendMessage(tab.id, controlMsg);
    const updatedState = await readState();
    return { ok: true, state: updatedState };
  } catch {
    return {
      ok: false,
      state: currentState,
      error:
        'Could not reach Instagram page script. Reload your open Instagram tab once and try again.',
    };
  }
}

async function handleOpenProfileTab(
  rawUsername: string,
  background = false,
): Promise<BridgeResponse> {
  const username = normalizeUsername(rawUsername);
  if (!username || !USERNAME_HANDLE_REGEX.test(username)) {
    const state = await readState();
    return { ok: false, state, error: 'Invalid Instagram username.' };
  }

  const url = buildProfileUrl(username);
  const state = await setActiveVisitedUsername(username);

  if (background) {
    await chrome.tabs.create({ url, active: false });
    return { ok: true, state };
  }

  const existingTab = await findTargetInstagramTab();
  if (existingTab && existingTab.id !== undefined) {
    await chrome.tabs.update(existingTab.id, { url, active: true });
    if (existingTab.windowId !== undefined && chrome.windows?.update) {
      chrome.windows.update(existingTab.windowId, { focused: true }).catch(() => {
        // Ignore window focus errors
      });
    }
  } else {
    await chrome.tabs.create({ url, active: true });
  }

  return { ok: true, state };
}

async function routeExtensionMessage(msg: ExtensionMessage): Promise<BridgeResponse> {
  switch (msg.type) {
    case 'GET_STATE': {
      const state = await readState();
      return { ok: true, state };
    }

    case 'UPSERT_ACCOUNTS_BATCH': {
      const state = await upsertAccountsBatch(msg.accounts);
      return { ok: true, state };
    }

    case 'SET_INTENT_BULK': {
      const state = await setIntentBulk(msg.usernames, msg.intent);
      return { ok: true, state };
    }

    case 'QUEUE_ACCOUNTS_BULK': {
      const state = await queueAccountsBulk(msg.usernames);
      return { ok: true, state };
    }

    case 'UNQUEUE_ACCOUNTS_BULK': {
      const state = await unqueueAccountsBulk(msg.usernames);
      return { ok: true, state };
    }

    case 'SET_ACCOUNT_STATUS': {
      return setAccountStatus(msg.username, msg.status, msg.recordTimestamp);
    }

    case 'PASSIVE_UNFOLLOW_DETECTED':
    case 'AUTO_UNFOLLOW_COMMITTED': {
      return recordUnfollowEvent(msg.username);
    }

    case 'PASSIVE_FOLLOW_DETECTED': {
      return recordFollowEvent(msg.username, msg.requested);
    }

    case 'SET_ACCOUNT_MODE': {
      const state = await setAccountMode(msg.mode);
      return { ok: true, state };
    }

    case 'SET_THEME': {
      const state = await setTheme(msg.theme);
      return { ok: true, state };
    }

    case 'SET_INCLUDE_FOLLOWING_MIGRATE': {
      const state = await setIncludeFollowingMigrate(msg.include);
      return { ok: true, state };
    }

    case 'UPDATE_SAFETY_LIMITS': {
      const state = await updateSafetyLimits(msg.limits, msg.automationConfig);
      return { ok: true, state };
    }

    case 'TRIP_CIRCUIT_BREAKER': {
      const state = await tripCircuitBreaker(msg.reason);
      await Promise.all([
        broadcastToAllInstagramTabs({ type: 'CONTENT_SCRAPER_CONTROL', action: 'stop' }),
        broadcastToAllInstagramTabs({ type: 'CONTENT_RUNNER_CONTROL', action: 'stop' }),
      ]);
      return { ok: true, state };
    }

    case 'CLEAR_CIRCUIT_BREAKER': {
      const state = await clearCircuitBreaker();
      return { ok: true, state };
    }

    case 'SCRAPER_COMMAND': {
      return forwardControlToInstagramTab({
        type: 'CONTENT_SCRAPER_CONTROL',
        action: msg.action,
      });
    }

    case 'SCRAPER_STATE_PATCH': {
      const state = await patchScraperState(msg.patch);
      return { ok: true, state };
    }

    case 'RUNNER_COMMAND': {
      return forwardControlToInstagramTab({
        type: 'CONTENT_RUNNER_CONTROL',
        action: msg.action,
      });
    }

    case 'RUNNER_STATE_PATCH': {
      const state = await patchRunnerState(msg.patch);
      return { ok: true, state };
    }

    case 'OPEN_PROFILE_TAB': {
      return handleOpenProfileTab(msg.username, msg.background);
    }

    case 'IMPORT_BACKUP': {
      return importBackupData(msg.data, msg.mode);
    }

    case 'RESET_ALL_DATA': {
      const state = await resetAllData();
      return { ok: true, state };
    }
  }
}

const KNOWN_MESSAGE_TYPES = new Set<ExtensionMessage['type']>([
  'GET_STATE',
  'UPSERT_ACCOUNTS_BATCH',
  'SET_INTENT_BULK',
  'QUEUE_ACCOUNTS_BULK',
  'UNQUEUE_ACCOUNTS_BULK',
  'SET_ACCOUNT_STATUS',
  'PASSIVE_UNFOLLOW_DETECTED',
  'PASSIVE_FOLLOW_DETECTED',
  'AUTO_UNFOLLOW_COMMITTED',
  'SET_ACCOUNT_MODE',
  'SET_THEME',
  'SET_INCLUDE_FOLLOWING_MIGRATE',
  'UPDATE_SAFETY_LIMITS',
  'TRIP_CIRCUIT_BREAKER',
  'CLEAR_CIRCUIT_BREAKER',
  'SCRAPER_COMMAND',
  'SCRAPER_STATE_PATCH',
  'RUNNER_COMMAND',
  'RUNNER_STATE_PATCH',
  'OPEN_PROFILE_TAB',
  'IMPORT_BACKUP',
  'RESET_ALL_DATA',
]);

function isExtensionMessage(raw: unknown): raw is ExtensionMessage {
  if (typeof raw !== 'object' || raw === null) {
    return false;
  }
  const maybeType = (raw as { type?: unknown }).type;
  return (
    typeof maybeType === 'string' &&
    KNOWN_MESSAGE_TYPES.has(maybeType as ExtensionMessage['type'])
  );
}

chrome.runtime.onMessage.addListener((rawMessage: unknown, _sender, sendResponse) => {
  if (!isExtensionMessage(rawMessage)) {
    return false;
  }

  routeExtensionMessage(rawMessage)
    .then((response) => {
      sendResponse(response);
    })
    .catch((err: unknown) => {
      sendResponse({
        ok: false,
        error: err instanceof Error ? err.message : 'Unexpected background worker error.',
      } satisfies BridgeResponse);
    });

  return true;
});
