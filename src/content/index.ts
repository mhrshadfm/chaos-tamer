import { autoUnfollowEngine } from './autoUnfollow';
import { passiveObserver } from './observer';
import {
  isNativeAndroidContentHost,
  sendContentRuntimeMessage,
  subscribeContentControlMessages,
} from './runtimeBridge';
import { followingScraper } from './scraper';

let bootedInCurrentContext = false;

function handleScraperAction(action: 'start' | 'pause' | 'resume' | 'stop'): void {
  switch (action) {
    case 'start':
      followingScraper.start();
      break;
    case 'pause':
      followingScraper.pause();
      break;
    case 'resume':
      followingScraper.resume();
      break;
    case 'stop':
      followingScraper.stop();
      break;
  }
}

function handleRunnerAction(action: 'start' | 'pause' | 'resume' | 'stop'): void {
  switch (action) {
    case 'start':
      autoUnfollowEngine.start();
      break;
    case 'pause':
      autoUnfollowEngine.pause();
      break;
    case 'resume':
      autoUnfollowEngine.resume();
      break;
    case 'stop':
      autoUnfollowEngine.stop();
      break;
  }
}

async function reconcileOrphanedSingleWebViewState(): Promise<void> {
  const res = await sendContentRuntimeMessage({ type: 'GET_STATE' });
  if (!res.ok || !res.state) {
    return;
  }
  const { scraper, runner } = res.state;
  if (
    !followingScraper.isActive() &&
    (scraper.scrollState === 'scanning' || scraper.scrollState === 'reading_pause')
  ) {
    await sendContentRuntimeMessage({
      type: 'SCRAPER_STATE_PATCH',
      patch: {
        scrollState: 'paused',
        statusText: 'Scan paused after page navigation — tap Resume on your Following list.',
      },
    });
  }
  if (
    !autoUnfollowEngine.isActive() &&
    (runner.state === 'running' ||
      runner.state === 'micro_break' ||
      runner.state === 'cooldown_paused')
  ) {
    await sendContentRuntimeMessage({
      type: 'RUNNER_STATE_PATCH',
      patch: {
        state: 'paused',
        countdownSec: 0,
        statusText: 'Paused after page navigation — tap Resume when ready.',
      },
    });
  }
}

function activateDomEngines(): void {
  passiveObserver.start();
  autoUnfollowEngine.resumeProfileFallbackIfPending();
  if (isNativeAndroidContentHost()) {
    void reconcileOrphanedSingleWebViewState();
  }
}

function bootChaosTamerContentScript(): void {
  if (bootedInCurrentContext) {
    return;
  }
  bootedInCurrentContext = true;

  const unsubscribeControl = subscribeContentControlMessages((message) => {
    if (message.type === 'CONTENT_SCRAPER_CONTROL') {
      handleScraperAction(message.action);
      return;
    }
    handleRunnerAction(message.action);
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', activateDomEngines, { once: true });
  } else {
    activateDomEngines();
  }

  window.addEventListener(
    'pagehide',
    () => {
      // Report an interrupted scan/run as "paused" (the tab is being reloaded or navigated,
      // e.g. by the Migrate stepper re-using this tab) instead of leaving a frozen "running".
      followingScraper.reportInterruptedByNavigation();
      autoUnfollowEngine.reportInterruptedByNavigation();
      unsubscribeControl();
      followingScraper.teardown();
      autoUnfollowEngine.teardown();
      passiveObserver.stop();
      bootedInCurrentContext = false;
    },
    { once: true },
  );
}

// Restored from the back/forward cache: the pagehide handler tore everything down, so boot again.
window.addEventListener('pageshow', (event) => {
  if (event.persisted) {
    bootChaosTamerContentScript();
  }
});

bootChaosTamerContentScript();
