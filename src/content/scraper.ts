import type { ScrapedAccountInput, ScraperLiveState } from '../types/schema';
import { hasContentRuntime, sendContentRuntimeMessage } from './runtimeBridge';
import {
  detectRestrictionPhrase,
  extractAccountsFromContainer,
  findActiveDialog,
  findScrollableModalContainer,
  hasVisibleProgressbar,
  isElementVisible,
} from './selectors';

const MODAL_MISSING_STATUS = 'Open your Instagram Following list or modal first, then tap Scan.';
const MAX_CONSECUTIVE_RETRIES = 6;
// Scroll cycles in a row without a single new account before the scan pauses itself. Guards against a
// loading spinner that never goes away (Instagram throttling), which previously kept the scan alive forever.
const MAX_STALLED_CYCLES = 45;
const MAX_SPINNER_WAITS = 8;
const READING_PAUSE_INTERVAL_STEPS = 15;

function randomInt(min: number, max: number): number {
  const low = Math.ceil(Math.min(min, max));
  const high = Math.floor(Math.max(min, max));
  return Math.floor(Math.random() * (high - low + 1)) + low;
}

const sendRuntimeMessage = sendContentRuntimeMessage;

export class FollowingModalScraper {
  private runToken = 0;
  private isScanning = false;
  private isPaused = false;

  private observer: MutationObserver | null = null;
  private mutationDebounceTimer: number | null = null;
  private sleepTimer: number | null = null;
  private sleepResolver: (() => void) | null = null;

  private initialStoredUsernames = new Set<string>();
  private seenInSession = new Set<string>();
  private newInSession = new Set<string>();
  private flushedByUsername = new Map<string, ScrapedAccountInput>();

  private stepCount = 0;
  private retryCount = 0;
  private stalledCycles = 0;

  public isActive(): boolean {
    return this.isScanning;
  }

  public start(): void {
    this.cleanupObserverAndTimers();
    this.runToken += 1;
    this.isScanning = true;
    this.isPaused = false;

    this.seenInSession.clear();
    this.newInSession.clear();
    this.flushedByUsername.clear();
    this.stepCount = 0;
    this.retryCount = 0;
    this.stalledCycles = 0;

    const currentToken = this.runToken;
    void this.runScanLoop(currentToken, true);
  }

  public pause(): void {
    if (!this.isScanning) {
      return;
    }
    this.runToken += 1;
    this.isScanning = false;
    this.isPaused = true;
    this.cleanupObserverAndTimers();

    void this.patchScraperState({
      scrollState: 'paused',
      extractedCount: this.seenInSession.size,
      sessionNewCount: this.newInSession.size,
      stepCount: this.stepCount,
      retryCount: this.retryCount,
      statusText: `Scan paused at ${this.seenInSession.size} accounts — click Resume to continue.`,
    });
  }

  public resume(): void {
    if (this.isScanning) {
      return;
    }
    if (!this.isPaused && this.seenInSession.size === 0) {
      this.start();
      return;
    }

    this.cleanupObserverAndTimers();
    this.runToken += 1;
    this.isScanning = true;
    this.isPaused = false;
    this.stalledCycles = 0;

    const currentToken = this.runToken;
    void this.runScanLoop(currentToken, false);
  }

  public stop(): void {
    const wasActiveOrPaused = this.isScanning || this.isPaused;
    this.runToken += 1;
    this.isScanning = false;
    this.isPaused = false;
    this.cleanupObserverAndTimers();

    if (wasActiveOrPaused) {
      void this.patchScraperState({
        scrollState: 'idle',
        extractedCount: this.seenInSession.size,
        sessionNewCount: this.newInSession.size,
        stepCount: this.stepCount,
        retryCount: 0,
        statusText:
          this.seenInSession.size > 0
            ? `Scan stopped — ${this.seenInSession.size} accounts harvested this session.`
            : 'Ready to scan your Instagram Following modal.',
      });
    }
  }

  /**
   * Called when the page is unloading mid-scan: report a resumable paused state instead of leaving
   * the side panel stuck on "scanning".
   */
  public reportInterruptedByNavigation(): void {
    if (!this.isScanning) {
      return;
    }
    this.runToken += 1;
    this.isScanning = false;
    this.isPaused = true;
    this.cleanupObserverAndTimers();
    void this.patchScraperState({
      scrollState: 'paused',
      extractedCount: this.seenInSession.size,
      sessionNewCount: this.newInSession.size,
      stepCount: this.stepCount,
      retryCount: this.retryCount,
      statusText: 'Scan paused — the Instagram page was reloaded or navigated away. Reopen your Following list and tap Resume.',
    });
  }

  public teardown(): void {
    this.runToken += 1;
    this.isScanning = false;
    this.isPaused = false;
    this.cleanupObserverAndTimers();
  }

  private cleanupObserverAndTimers(): void {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    if (this.mutationDebounceTimer !== null) {
      window.clearTimeout(this.mutationDebounceTimer);
      this.mutationDebounceTimer = null;
    }
    if (this.sleepTimer !== null) {
      window.clearTimeout(this.sleepTimer);
      this.sleepTimer = null;
    }
    if (this.sleepResolver) {
      const resolve = this.sleepResolver;
      this.sleepResolver = null;
      resolve();
    }
  }

  private sleepInterruptible(ms: number, token: number): Promise<boolean> {
    if (token !== this.runToken) {
      return Promise.resolve(false);
    }
    return new Promise<boolean>((resolve) => {
      this.sleepResolver = () => {
        resolve(token === this.runToken);
      };
      this.sleepTimer = window.setTimeout(() => {
        this.sleepTimer = null;
        const finish = this.sleepResolver;
        this.sleepResolver = null;
        if (finish) {
          finish();
        }
      }, ms);
    });
  }

  private async patchScraperState(patch: Partial<ScraperLiveState>): Promise<void> {
    await sendRuntimeMessage({
      type: 'SCRAPER_STATE_PATCH',
      patch,
    });
  }

  private attachDialogObserver(dialog: HTMLElement, token: number): void {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }

    this.observer = new MutationObserver(() => {
      if (token !== this.runToken || !this.isScanning) {
        return;
      }
      if (this.mutationDebounceTimer !== null) {
        return;
      }
      this.mutationDebounceTimer = window.setTimeout(() => {
        this.mutationDebounceTimer = null;
        if (token !== this.runToken || !this.isScanning || !dialog.isConnected) {
          return;
        }
        void this.harvestMountedRows(dialog);
      }, 160);
    });

    this.observer.observe(dialog, {
      childList: true,
      subtree: true,
    });
  }

  private async harvestMountedRows(dialog: HTMLElement): Promise<number> {
    if (!dialog.isConnected) {
      return 0;
    }

    const extracted = extractAccountsFromContainer(dialog);
    if (extracted.length === 0) {
      return 0;
    }

    const batchToUpsert: ScrapedAccountInput[] = [];
    let newlySeenCount = 0;

    for (const item of extracted) {
      const username = item.username.toLowerCase();
      if (!this.seenInSession.has(username)) {
        this.seenInSession.add(username);
        newlySeenCount += 1;
        if (!this.initialStoredUsernames.has(username)) {
          this.newInSession.add(username);
        }
        this.flushedByUsername.set(username, item);
        batchToUpsert.push(item);
      } else {
        const previous = this.flushedByUsername.get(username);
        const gainedAvatar = Boolean(item.avatarUrl && !previous?.avatarUrl);
        const gainedDisplayName = Boolean(item.displayName && !previous?.displayName);
        if (gainedAvatar || gainedDisplayName) {
          this.flushedByUsername.set(username, item);
          batchToUpsert.push(item);
        }
      }
    }

    if (batchToUpsert.length > 0) {
      await sendRuntimeMessage({
        type: 'UPSERT_ACCOUNTS_BATCH',
        accounts: batchToUpsert,
      });
    }

    return newlySeenCount;
  }

  private resolveModalTargets(): { dialog: HTMLElement; scrollContainer: HTMLElement } | null {
    const dialog = findActiveDialog('following_list');
    if (!dialog) {
      return null;
    }

    const scrollContainer = findScrollableModalContainer(dialog);
    if (scrollContainer) {
      return { dialog, scrollContainer };
    }

    const mountedAccounts = extractAccountsFromContainer(dialog);
    if (mountedAccounts.length > 0 || hasVisibleProgressbar(dialog)) {
      return { dialog, scrollContainer: dialog };
    }

    return null;
  }

  private async failWithMissingModal(): Promise<void> {
    this.runToken += 1;
    this.isScanning = false;
    this.isPaused = false;
    this.cleanupObserverAndTimers();

    await this.patchScraperState({
      scrollState: 'error',
      extractedCount: this.seenInSession.size,
      sessionNewCount: this.newInSession.size,
      stepCount: this.stepCount,
      retryCount: this.retryCount,
      statusText: MODAL_MISSING_STATUS,
    });
  }

  private async runScanLoop(token: number, isFreshStart: boolean): Promise<void> {
    if (isFreshStart) {
      const stateRes = await sendRuntimeMessage({ type: 'GET_STATE' });
      if (token !== this.runToken) {
        return;
      }
      if (stateRes.ok && stateRes.state) {
        if (stateRes.state.safety.emergencyStopReason) {
          this.isScanning = false;
          this.cleanupObserverAndTimers();
          await this.patchScraperState({
            scrollState: 'error',
            statusText: stateRes.state.safety.emergencyStopReason,
          });
          return;
        }
        this.initialStoredUsernames = new Set(Object.keys(stateRes.state.accounts));
      }
    }

    const initialTargets = this.resolveModalTargets();
    if (!initialTargets) {
      await this.failWithMissingModal();
      return;
    }

    this.attachDialogObserver(initialTargets.dialog, token);

    await this.harvestMountedRows(initialTargets.dialog);
    if (token !== this.runToken) {
      return;
    }

    await this.patchScraperState({
      scrollState: 'scanning',
      extractedCount: this.seenInSession.size,
      sessionNewCount: this.newInSession.size,
      stepCount: this.stepCount,
      retryCount: this.retryCount,
      statusText: `Scanning Following modal… (${this.seenInSession.size} seen in session)`,
    });

    while (token === this.runToken && this.isScanning) {
      if (!hasContentRuntime()) {
        this.teardown();
        return;
      }

      const restriction = detectRestrictionPhrase();
      if (restriction) {
        this.runToken += 1;
        this.isScanning = false;
        this.cleanupObserverAndTimers();
        await sendRuntimeMessage({ type: 'TRIP_CIRCUIT_BREAKER', reason: restriction });
        return;
      }

      const targets = this.resolveModalTargets();
      if (!targets || !isElementVisible(targets.dialog)) {
        await this.failWithMissingModal();
        return;
      }

      const { dialog, scrollContainer } = targets;

      let spinnerWaits = 0;
      while (
        token === this.runToken &&
        this.isScanning &&
        hasVisibleProgressbar(dialog) &&
        spinnerWaits < MAX_SPINNER_WAITS
      ) {
        spinnerWaits += 1;
        await this.patchScraperState({
          scrollState: 'scanning',
          extractedCount: this.seenInSession.size,
          sessionNewCount: this.newInSession.size,
          stepCount: this.stepCount,
          retryCount: this.retryCount,
          statusText: `Waiting for Instagram list spinner… (${this.seenInSession.size} harvested)`,
        });
        const keepGoing = await this.sleepInterruptible(randomInt(950, 1450), token);
        if (!keepGoing) {
          return;
        }
        await this.harvestMountedRows(dialog);
      }

      if (token !== this.runToken || !this.isScanning) {
        return;
      }

      const countBeforeStep = this.seenInSession.size;

      const ratio = 0.65 + Math.random() * 0.25;
      const viewportHeight = Math.max(scrollContainer.clientHeight, 240);
      const delta = Math.max(150, Math.round(viewportHeight * ratio));

      scrollContainer.scrollBy({ top: delta, behavior: 'smooth' });
      this.stepCount += 1;

      const stepDelayMs = randomInt(1250, 2550);
      const aliveAfterScroll = await this.sleepInterruptible(stepDelayMs, token);
      if (!aliveAfterScroll) {
        return;
      }

      if (!dialog.isConnected || !isElementVisible(dialog)) {
        await this.failWithMissingModal();
        return;
      }

      await this.harvestMountedRows(dialog);
      if (token !== this.runToken || !this.isScanning) {
        return;
      }

      const newThisCycle = this.seenInSession.size - countBeforeStep;
      const atBottom =
        scrollContainer.scrollTop + scrollContainer.clientHeight >=
        scrollContainer.scrollHeight - 24;

      if (newThisCycle > 0) {
        this.retryCount = 0;
        this.stalledCycles = 0;
      } else {
        this.stalledCycles += 1;
      }

      if (this.stalledCycles >= MAX_STALLED_CYCLES) {
        this.runToken += 1;
        this.isScanning = false;
        this.isPaused = true;
        this.cleanupObserverAndTimers();
        await this.patchScraperState({
          scrollState: 'paused',
          extractedCount: this.seenInSession.size,
          sessionNewCount: this.newInSession.size,
          stepCount: this.stepCount,
          retryCount: this.retryCount,
          statusText: `No new accounts loaded for a while (Instagram may be throttling) — paused at ${this.seenInSession.size}. Tap Resume to retry.`,
        });
        return;
      }

      if (newThisCycle > 0) {
        // progress made — retryCount already reset above
      } else if (atBottom && !hasVisibleProgressbar(dialog)) {
        this.retryCount += 1;
      } else if (!atBottom && scrollContainer.scrollHeight <= scrollContainer.clientHeight + 2) {
        this.retryCount += 1;
      }

      if (this.retryCount >= MAX_CONSECUTIVE_RETRIES && atBottom) {
        this.runToken += 1;
        this.isScanning = false;
        this.isPaused = false;
        this.cleanupObserverAndTimers();

        await this.patchScraperState({
          scrollState: 'completed',
          extractedCount: this.seenInSession.size,
          sessionNewCount: this.newInSession.size,
          stepCount: this.stepCount,
          retryCount: this.retryCount,
          statusText: `Scan complete — ${this.seenInSession.size} accounts verified (${this.newInSession.size} newly added).`,
        });
        return;
      }

      if (this.stepCount > 0 && this.stepCount % READING_PAUSE_INTERVAL_STEPS === 0) {
        const readingPauseMs = randomInt(4000, 7000);
        await this.patchScraperState({
          scrollState: 'reading_pause',
          extractedCount: this.seenInSession.size,
          sessionNewCount: this.newInSession.size,
          stepCount: this.stepCount,
          retryCount: this.retryCount,
          statusText: `Humanized reading pause (${Math.round(readingPauseMs / 1000)}s) — ${this.seenInSession.size} harvested…`,
        });

        const aliveAfterPause = await this.sleepInterruptible(readingPauseMs, token);
        if (!aliveAfterPause) {
          return;
        }
        await this.harvestMountedRows(dialog);
      }

      await this.patchScraperState({
        scrollState: 'scanning',
        extractedCount: this.seenInSession.size,
        sessionNewCount: this.newInSession.size,
        stepCount: this.stepCount,
        retryCount: this.retryCount,
        statusText:
          this.retryCount > 0
            ? `Verifying end of list (check ${this.retryCount}/${MAX_CONSECUTIVE_RETRIES}) · ${this.seenInSession.size} harvested`
            : `Scanning Following modal… ${this.seenInSession.size} seen (${this.newInSession.size} new)`,
      });
    }
  }
}

export const followingScraper = new FollowingModalScraper();
