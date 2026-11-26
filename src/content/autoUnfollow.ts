import {
  evaluateRateLimit,
  formatDurationMmSs,
  sampleTruncatedGaussianSec,
} from '../lib/rateLimiter';
import { buildProfileUrl } from '../lib/constants';
import type { AccountRecord, RunnerLiveState, StorageStateV1 } from '../types/schema';
import { hasContentRuntime, sendContentRuntimeMessage } from './runtimeBridge';
import {
  classifyButtonLabel,
  detectRestrictionPhrase,
  findAccountRowInContainer,
  findActiveDialog,
  findConfirmationDialogWithButton,
  findProfileHeaderActionButton,
  findScrollableModalContainer,
  isElementVisible,
  parseProfileUsernameFromPath,
} from './selectors';

const PROFILE_FALLBACK_SESSION_KEY = 'chaos_tamer_profile_fallback_v1';
const PROFILE_FALLBACK_MAX_AGE_MS = 180_000;
const MAX_MODAL_SEARCH_STEPS = 25;
const MISSING_MODAL_GUIDANCE =
  'Open the Following list/modal or enable Profile Fallback in Data & Limits.';

interface ProfileFallbackSessionPayload {
  active: true;
  targetUsername: string;
  sessionUnfollowedCount: number;
  savedAt: number;
}

const syntheticRunnerEvents = new WeakSet<Event>();
let runnerSuppressionDepth = 0;

/**
 * Checks whether a DOM event was synthesized by Mode B (`AutoUnfollowEngine`),
 * preventing Mode A (`observer.ts`) from double-recording automated unfollows.
 */
export function isSyntheticRunnerEvent(event: Event): boolean {
  return syntheticRunnerEvents.has(event);
}

/**
 * Indicates whether Mode B is actively dispatching a synthetic pointer/mouse click sequence.
 */
export function isRunnerSuppressingPassiveClicks(): boolean {
  return runnerSuppressionDepth > 0;
}

function randomInt(min: number, max: number): number {
  const low = Math.ceil(Math.min(min, max));
  const high = Math.floor(Math.max(min, max));
  return Math.floor(Math.random() * (high - low + 1)) + low;
}

const sendRuntimeMessage = sendContentRuntimeMessage;

function readFallbackSession(): ProfileFallbackSessionPayload | null {
  try {
    const raw = window.sessionStorage.getItem(PROFILE_FALLBACK_SESSION_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<ProfileFallbackSessionPayload>;
    if (
      parsed &&
      parsed.active === true &&
      typeof parsed.targetUsername === 'string' &&
      typeof parsed.sessionUnfollowedCount === 'number' &&
      typeof parsed.savedAt === 'number'
    ) {
      if (Date.now() - parsed.savedAt <= PROFILE_FALLBACK_MAX_AGE_MS) {
        return {
          active: true,
          targetUsername: parsed.targetUsername.toLowerCase(),
          sessionUnfollowedCount: parsed.sessionUnfollowedCount,
          savedAt: parsed.savedAt,
        };
      }
    }
    window.sessionStorage.removeItem(PROFILE_FALLBACK_SESSION_KEY);
    return null;
  } catch {
    return null;
  }
}

function writeFallbackSession(targetUsername: string, sessionUnfollowedCount: number): void {
  try {
    const payload: ProfileFallbackSessionPayload = {
      active: true,
      targetUsername: targetUsername.toLowerCase(),
      sessionUnfollowedCount,
      savedAt: Date.now(),
    };
    window.sessionStorage.setItem(PROFILE_FALLBACK_SESSION_KEY, JSON.stringify(payload));
  } catch {
    // Ignore sessionStorage quota or privacy errors
  }
}

function clearFallbackSession(): void {
  try {
    window.sessionStorage.removeItem(PROFILE_FALLBACK_SESSION_KEY);
  } catch {
    // Ignore sessionStorage errors
  }
}

function getQueuedAccountsSorted(state: StorageStateV1): AccountRecord[] {
  return Object.values(state.accounts)
    .filter((acc) => acc.status === 'queued_unfollow')
    .sort((a, b) => {
      if (a.extractedAt !== b.extractedAt) {
        return a.extractedAt - b.extractedAt;
      }
      return a.username.localeCompare(b.username);
    });
}

/**
 * Dispatches a humanized pointer + mouse event sequence on `targetEl` with realistic viewport coordinates.
 */
function dispatchHumanizedClick(targetEl: HTMLElement): void {
  const rect = targetEl.getBoundingClientRect();
  const jitterX = 0.35 + Math.random() * 0.3;
  const jitterY = 0.35 + Math.random() * 0.3;
  const clientX = Math.round(rect.left + Math.max(2, rect.width * jitterX));
  const clientY = Math.round(rect.top + Math.max(2, rect.height * jitterY));

  const sharedMouseInit: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX,
    clientY,
    button: 0,
  };

  const events: Event[] = [];

  if (typeof PointerEvent === 'function') {
    events.push(
      new PointerEvent('pointerdown', {
        ...sharedMouseInit,
        buttons: 1,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
      }),
    );
  }

  events.push(
    new MouseEvent('mousedown', {
      ...sharedMouseInit,
      buttons: 1,
      detail: 1,
    }),
  );

  if (typeof PointerEvent === 'function') {
    events.push(
      new PointerEvent('pointerup', {
        ...sharedMouseInit,
        buttons: 0,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
      }),
    );
  }

  events.push(
    new MouseEvent('mouseup', {
      ...sharedMouseInit,
      buttons: 0,
      detail: 1,
    }),
    new MouseEvent('click', {
      ...sharedMouseInit,
      buttons: 0,
      detail: 1,
    }),
  );

  for (const ev of events) {
    syntheticRunnerEvents.add(ev);
  }

  runnerSuppressionDepth += 1;
  try {
    for (const ev of events) {
      targetEl.dispatchEvent(ev);
    }
  } finally {
    window.setTimeout(() => {
      runnerSuppressionDepth = Math.max(0, runnerSuppressionDepth - 1);
    }, 50);
  }
}

export class AutoUnfollowEngine {
  private runToken = 0;
  private isLoopActive = false;
  private sessionUnfollowedCount = 0;

  private sleepTimer: number | null = null;
  private sleepResolver: (() => void) | null = null;

  // Humanized pacing survives Pause→Resume and Stop→Start inside this tab, so toggling the
  // runner can never skip the Gaussian inter-action delay or a due micro-break.
  private nextActionNotBefore = 0;
  private pendingMicroBreak = false;
  private actionsSinceBreak = 0;
  private lastCommittedAt = 0;

  public isActive(): boolean {
    return this.isLoopActive;
  }

  /**
   * Releases the loop flag only if the calling loop still owns the current run. A stale loop
   * that wakes up after a fast Pause→Resume must not flip the NEW run's flag to inactive.
   */
  private releaseLoop(token: number): void {
    if (token === this.runToken) {
      this.isLoopActive = false;
    }
  }

  /**
   * Called when the page is being unloaded (reload / navigation away). Reports the interrupted
   * run as paused so the side panel never shows a frozen "running" countdown.
   */
  public reportInterruptedByNavigation(): void {
    if (!this.isLoopActive || readFallbackSession() !== null) {
      return;
    }
    this.runToken += 1;
    this.isLoopActive = false;
    this.cancelTimers();
    void this.patchRunnerState({
      state: 'paused',
      countdownSec: 0,
      sessionUnfollowedCount: this.sessionUnfollowedCount,
      statusText: 'Paused — the Instagram page was reloaded or navigated away. Tap Resume when ready.',
    });
  }

  private recordCommittedAction(): void {
    this.sessionUnfollowedCount += 1;
    this.actionsSinceBreak += 1;
    this.lastCommittedAt = Date.now();
  }

  /**
   * After the final confirm click has been dispatched the unfollow may already be done on
   * Instagram's side. If the run is interrupted (Stop / Pause / breaker) in that window, keep
   * watching briefly (not interruptible) and still record it, so it counts toward the caps.
   */
  private async commitIfFlippedAfterInterrupt(
    account: AccountRecord,
    surface: 'modal' | 'profile',
  ): Promise<void> {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      if (this.hasButtonFlippedToFollow(account.username, surface)) {
        await sendRuntimeMessage({ type: 'AUTO_UNFOLLOW_COMMITTED', username: account.username });
        this.recordCommittedAction();
        return;
      }
      await new Promise<void>((resolve) => window.setTimeout(resolve, 200));
    }
  }

  public start(): void {
    if (this.isLoopActive) {
      return;
    }
    clearFallbackSession();
    this.cancelTimers();
    this.runToken += 1;
    this.isLoopActive = true;
    this.sessionUnfollowedCount = 0;

    const currentToken = this.runToken;
    void this.executeLoop(currentToken);
  }

  public pause(): void {
    // Pause/Stop are broadcast to every Instagram tab. Only the tab that actually owns the run
    // (or a pending profile-fallback hop) reports state; idle tabs must not clobber it.
    const ownedRun = this.isLoopActive || readFallbackSession() !== null;
    clearFallbackSession();
    this.runToken += 1;
    this.isLoopActive = false;
    this.cancelTimers();

    if (!ownedRun) {
      return;
    }
    void this.patchRunnerState({
      state: 'paused',
      countdownSec: 0,
      sessionUnfollowedCount: this.sessionUnfollowedCount,
      statusText: 'Safe auto-unfollow paused.',
    });
  }

  public resume(): void {
    if (this.isLoopActive) {
      return;
    }
    clearFallbackSession();
    this.cancelTimers();
    this.runToken += 1;
    this.isLoopActive = true;

    const currentToken = this.runToken;
    void this.executeLoop(currentToken);
  }

  public stop(): void {
    const ownedRun = this.isLoopActive || readFallbackSession() !== null;
    clearFallbackSession();
    this.runToken += 1;
    this.isLoopActive = false;
    this.sessionUnfollowedCount = 0;
    this.cancelTimers();

    if (!ownedRun) {
      return;
    }
    void this.patchRunnerState({
      state: 'idle',
      currentTarget: undefined,
      countdownSec: 0,
      sessionUnfollowedCount: 0,
      statusText: 'Safe auto-unfollow stopped.',
    });
  }

  public abortCircuitBreaker(reason: string): void {
    clearFallbackSession();
    this.runToken += 1;
    this.isLoopActive = false;
    this.cancelTimers();

    void this.patchRunnerState({
      state: 'circuit_tripped',
      countdownSec: 0,
      sessionUnfollowedCount: this.sessionUnfollowedCount,
      statusText: reason,
    });
  }

  public resumeProfileFallbackIfPending(): void {
    if (this.isLoopActive) {
      return;
    }
    const pending = readFallbackSession();
    if (!pending) {
      return;
    }

    this.cancelTimers();
    this.runToken += 1;
    this.isLoopActive = true;
    this.sessionUnfollowedCount = pending.sessionUnfollowedCount;

    const currentToken = this.runToken;
    void this.executeLoop(currentToken, pending.targetUsername, true);
  }

  public teardown(): void {
    this.runToken += 1;
    this.isLoopActive = false;
    this.cancelTimers();
  }

  private cancelTimers(): void {
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

  private async patchRunnerState(patch: Partial<RunnerLiveState>): Promise<void> {
    await sendRuntimeMessage({
      type: 'RUNNER_STATE_PATCH',
      patch,
    });
  }

  private async fetchFreshState(token: number): Promise<StorageStateV1 | null> {
    if (token !== this.runToken) {
      return null;
    }
    const res = await sendRuntimeMessage({ type: 'GET_STATE' });
    if (token !== this.runToken || !res.ok || !res.state) {
      return null;
    }
    return res.state;
  }

  private async checkForRestrictionAndTripIfFound(): Promise<boolean> {
    const restriction = detectRestrictionPhrase();
    if (!restriction) {
      return false;
    }
    this.abortCircuitBreaker(restriction);
    await sendRuntimeMessage({ type: 'TRIP_CIRCUIT_BREAKER', reason: restriction });
    return true;
  }

  private async streamPerSecondCountdown(
    totalSeconds: number,
    execState: 'running' | 'cooldown_paused' | 'micro_break',
    targetUsername: string | undefined,
    buildStatusText: (secRemaining: number) => string,
    token: number,
  ): Promise<boolean> {
    let sec = Math.max(1, Math.ceil(totalSeconds));

    while (sec > 0 && token === this.runToken && this.isLoopActive) {
      if (await this.checkForRestrictionAndTripIfFound()) {
        return false;
      }

      await this.patchRunnerState({
        state: execState,
        currentTarget: targetUsername,
        countdownSec: sec,
        sessionUnfollowedCount: this.sessionUnfollowedCount,
        statusText: buildStatusText(sec),
      });

      const alive = await this.sleepInterruptible(1000, token);
      if (!alive) {
        return false;
      }
      sec -= 1;
    }

    return token === this.runToken && this.isLoopActive;
  }

  private async acquireTargetButton(
    account: AccountRecord,
    profileFallbackAllowed: boolean,
    isFallbackResumeForTarget: boolean,
    token: number,
  ): Promise<
    | { kind: 'ready'; button: HTMLElement; scrollTarget: HTMLElement; surface: 'modal' | 'profile' }
    | { kind: 'already_unfollowed' }
    | { kind: 'navigated_fallback' }
    | { kind: 'paused_guidance'; message: string }
    | { kind: 'aborted' }
  > {
    const dialog = findActiveDialog('following_list');

    if (dialog) {
      let rowMatch = findAccountRowInContainer(dialog, account.username);
      if (!rowMatch) {
        const scrollContainer = findScrollableModalContainer(dialog);
        if (scrollContainer) {
          let wrappedToTopOnce = false;

          for (let step = 0; step < MAX_MODAL_SEARCH_STEPS; step += 1) {
            if (token !== this.runToken || !this.isLoopActive) {
              return { kind: 'aborted' };
            }
            if (await this.checkForRestrictionAndTripIfFound()) {
              return { kind: 'aborted' };
            }
            if (!dialog.isConnected || !isElementVisible(dialog)) {
              break;
            }

            await this.patchRunnerState({
              state: 'running',
              currentTarget: account.username,
              countdownSec: 0,
              sessionUnfollowedCount: this.sessionUnfollowedCount,
              statusText: `Searching Following modal for @${account.username} (step ${step + 1}/${MAX_MODAL_SEARCH_STEPS})…`,
            });

            const atBottom =
              scrollContainer.scrollTop + scrollContainer.clientHeight >=
              scrollContainer.scrollHeight - 24;

            if (atBottom && !wrappedToTopOnce && scrollContainer.scrollTop > 40) {
              wrappedToTopOnce = true;
              scrollContainer.scrollTo({ top: 0, behavior: 'auto' });
              const aliveWrap = await this.sleepInterruptible(650, token);
              if (!aliveWrap) {
                return { kind: 'aborted' };
              }
            } else {
              const delta = Math.max(160, Math.round(scrollContainer.clientHeight * 0.75));
              scrollContainer.scrollBy({ top: delta, behavior: 'smooth' });
              const aliveScroll = await this.sleepInterruptible(randomInt(550, 820), token);
              if (!aliveScroll) {
                return { kind: 'aborted' };
              }
            }

            rowMatch = findAccountRowInContainer(dialog, account.username);
            if (rowMatch) {
              break;
            }
          }
        }
      }

      if (rowMatch) {
        if (rowMatch.buttonKind === 'follow') {
          return { kind: 'already_unfollowed' };
        }
        if (
          rowMatch.actionButton &&
          (rowMatch.buttonKind === 'following' || rowMatch.buttonKind === 'requested')
        ) {
          return {
            kind: 'ready',
            button: rowMatch.actionButton,
            scrollTarget: rowMatch.row,
            surface: 'modal',
          };
        }
      }
    }

    const currentPathUsername = parseProfileUsernameFromPath(window.location.pathname);
    if (
      currentPathUsername === account.username &&
      (profileFallbackAllowed || isFallbackResumeForTarget)
    ) {
      await this.patchRunnerState({
        state: 'running',
        currentTarget: account.username,
        countdownSec: 0,
        sessionUnfollowedCount: this.sessionUnfollowedCount,
        statusText: `Waiting for @${account.username} profile header…`,
      });

      const deadline = Date.now() + 8_500;
      while (Date.now() < deadline && token === this.runToken && this.isLoopActive) {
        if (await this.checkForRestrictionAndTripIfFound()) {
          return { kind: 'aborted' };
        }
        const headerMatch = findProfileHeaderActionButton(['following', 'requested', 'follow']);
        if (headerMatch) {
          clearFallbackSession();
          if (headerMatch.kind === 'follow') {
            return { kind: 'already_unfollowed' };
          }
          return {
            kind: 'ready',
            button: headerMatch.button,
            scrollTarget: headerMatch.button,
            surface: 'profile',
          };
        }
        const alive = await this.sleepInterruptible(300, token);
        if (!alive) {
          return { kind: 'aborted' };
        }
      }

      clearFallbackSession();
      return {
        kind: 'paused_guidance',
        message: `Could not locate Following button on @${account.username} profile — paused for safety.`,
      };
    }

    if (profileFallbackAllowed) {
      writeFallbackSession(account.username, this.sessionUnfollowedCount);
      await this.patchRunnerState({
        state: 'running',
        currentTarget: account.username,
        countdownSec: 0,
        sessionUnfollowedCount: this.sessionUnfollowedCount,
        statusText: `Navigating to @${account.username} via Profile Fallback…`,
      });
      window.location.assign(buildProfileUrl(account.username));
      return { kind: 'navigated_fallback' };
    }

    clearFallbackSession();
    return {
      kind: 'paused_guidance',
      message: MISSING_MODAL_GUIDANCE,
    };
  }

  private reResolveActionButton(
    username: string,
    surface: 'modal' | 'profile',
    fallbackButton: HTMLElement,
  ): HTMLElement | null {
    if (surface === 'modal') {
      const dialog = findActiveDialog('following_list');
      if (dialog) {
        const refreshed = findAccountRowInContainer(dialog, username);
        if (
          refreshed?.actionButton &&
          (refreshed.buttonKind === 'following' || refreshed.buttonKind === 'requested')
        ) {
          return refreshed.actionButton;
        }
      }
    } else {
      const headerMatch = findProfileHeaderActionButton(['following', 'requested']);
      if (headerMatch) {
        return headerMatch.button;
      }
    }

    if (fallbackButton.isConnected && isElementVisible(fallbackButton)) {
      const kind = classifyButtonLabel(fallbackButton);
      if (kind === 'following' || kind === 'requested') {
        return fallbackButton;
      }
    }
    return null;
  }

  private hasButtonFlippedToFollow(username: string, surface: 'modal' | 'profile'): boolean {
    if (surface === 'modal') {
      const dialog = findActiveDialog('following_list');
      if (!dialog) {
        return false;
      }
      const rowMatch = findAccountRowInContainer(dialog, username);
      return rowMatch?.buttonKind === 'follow';
    }
    const headerMatch = findProfileHeaderActionButton(['follow']);
    return headerMatch?.kind === 'follow';
  }

  private async performSingleUnfollow(
    account: AccountRecord,
    initialButton: HTMLElement,
    scrollTarget: HTMLElement,
    surface: 'modal' | 'profile',
    token: number,
  ): Promise<'committed' | 'paused_error' | 'aborted'> {
    await this.patchRunnerState({
      state: 'running',
      currentTarget: account.username,
      countdownSec: 0,
      sessionUnfollowedCount: this.sessionUnfollowedCount,
      statusText: `Unfollowing @${account.username}…`,
    });

    scrollTarget.scrollIntoView({ behavior: 'smooth', block: 'center' });

    const preClickPauseMs = randomInt(450, 950);
    const aliveBeforeClick = await this.sleepInterruptible(preClickPauseMs, token);
    if (!aliveBeforeClick) {
      return 'aborted';
    }

    if (await this.checkForRestrictionAndTripIfFound()) {
      return 'aborted';
    }

    // A confirmation sheet left open (e.g. Pause landed between the two clicks of a previous
    // target) would otherwise be confirmed for the WRONG account below.
    if (findConfirmationDialogWithButton()) {
      await this.pauseWithReason(
        account.username,
        'An Instagram "Unfollow?" dialog is already open — close it (Cancel), then tap Resume.',
      );
      return 'paused_error';
    }

    const liveFollowingBtn = this.reResolveActionButton(account.username, surface, initialButton);
    if (!liveFollowingBtn) {
      if (this.hasButtonFlippedToFollow(account.username, surface)) {
        await sendRuntimeMessage({
          type: 'SET_ACCOUNT_STATUS',
          username: account.username,
          status: account.intent === 'migrate' ? 'unfollowed_migrate' : 'unfollowed_dropped',
          recordTimestamp: false,
        });
        return 'committed';
      }
      await this.pauseWithReason(
        account.username,
        `Lost Following button reference for @${account.username} — paused cleanly.`,
      );
      return 'paused_error';
    }

    dispatchHumanizedClick(liveFollowingBtn);

    const reactionDelayMs = randomInt(950, 2350);
    const aliveAfterReaction = await this.sleepInterruptible(reactionDelayMs, token);
    if (!aliveAfterReaction) {
      return 'aborted';
    }

    if (await this.checkForRestrictionAndTripIfFound()) {
      return 'aborted';
    }

    let confirmTarget = findConfirmationDialogWithButton();
    if (!confirmTarget) {
      const extraWaitDeadline = Date.now() + 1_200;
      while (!confirmTarget && Date.now() < extraWaitDeadline && token === this.runToken) {
        const alivePoll = await this.sleepInterruptible(200, token);
        if (!alivePoll) {
          return 'aborted';
        }
        confirmTarget = findConfirmationDialogWithButton();
      }
    }

    if (!confirmTarget) {
      if (this.hasButtonFlippedToFollow(account.username, surface)) {
        await sendRuntimeMessage({
          type: 'AUTO_UNFOLLOW_COMMITTED',
          username: account.username,
        });
        this.recordCommittedAction();
        return 'committed';
      }
      await this.pauseWithReason(
        account.username,
        `Instagram confirmation dialog did not appear for @${account.username} — paused for safety.`,
      );
      return 'paused_error';
    }

    let currentConfirmDialog = confirmTarget.dialog;
    let currentConfirmButton = confirmTarget.confirmButton;
    let clickedSecondConfirm = false;
    let lastConfirmClickAt = Date.now();
    dispatchHumanizedClick(currentConfirmButton);

    // From here on the unfollow may already have happened server-side.
    const abortAfterConfirm = async (): Promise<'aborted'> => {
      await this.commitIfFlippedAfterInterrupt(account, surface);
      return 'aborted';
    };

    let verifyDeadline = Date.now() + 3_200;
    let verified = false;
    let dialogClosedSince: number | null = null;
    // How long a closed confirmation sheet may stay closed without the button flipping before we
    // accept it as done. Private accounts mount a 2nd "Unfollow?" dialog after a short delay.
    const DIALOG_CLOSED_GRACE_MS = 1_200;

    while (Date.now() < verifyDeadline && token === this.runToken && this.isLoopActive) {
      const aliveVerify = await this.sleepInterruptible(160, token);
      if (!aliveVerify) {
        return abortAfterConfirm();
      }
      if (await this.checkForRestrictionAndTripIfFound()) {
        return abortAfterConfirm();
      }

      if (this.hasButtonFlippedToFollow(account.username, surface)) {
        verified = true;
        break;
      }

      // Handle 2-step Unfollow flows (e.g. Profile Relationship Sheet -> Private Account Unfollow Confirmation)
      const activeConfirm = findConfirmationDialogWithButton();
      if (
        activeConfirm &&
        !clickedSecondConfirm &&
        activeConfirm.confirmButton !== currentConfirmButton &&
        Date.now() - lastConfirmClickAt >= 260
      ) {
        clickedSecondConfirm = true;
        currentConfirmDialog = activeConfirm.dialog;
        currentConfirmButton = activeConfirm.confirmButton;
        lastConfirmClickAt = Date.now();
        dialogClosedSince = null;
        dispatchHumanizedClick(currentConfirmButton);
        verifyDeadline = Date.now() + 3_200;
        continue;
      }

      const dialogClosed =
        !currentConfirmDialog.isConnected || !isElementVisible(currentConfirmDialog);
      if (dialogClosed && !activeConfirm) {
        if (dialogClosedSince === null) {
          dialogClosedSince = Date.now();
        }
        // Keep polling for the button flip / a late 2nd confirmation dialog before accepting
        // "dialog closed" as success (accepting it after ~280ms marked still-followed private
        // accounts as unfollowed).
        if (Date.now() - dialogClosedSince >= DIALOG_CLOSED_GRACE_MS) {
          verified = true;
          break;
        }
        verifyDeadline = Math.max(verifyDeadline, dialogClosedSince + DIALOG_CLOSED_GRACE_MS + 400);
      } else {
        dialogClosedSince = null;
      }
    }

    if (!verified) {
      if (token !== this.runToken || !this.isLoopActive) {
        return abortAfterConfirm();
      }
      if (await this.checkForRestrictionAndTripIfFound()) {
        return abortAfterConfirm();
      }
      await this.pauseWithReason(
        account.username,
        `Unfollow confirmation for @${account.username} timed out after 3s — paused for safety.`,
      );
      return 'paused_error';
    }

    // Verified: record it now. Deferring this behind another interruptible sleep let a Stop or
    // Pause in that window drop a real unfollow from the rolling rate-limit history.
    await sendRuntimeMessage({
      type: 'AUTO_UNFOLLOW_COMMITTED',
      username: account.username,
    });
    this.recordCommittedAction();

    const settleAlive = await this.sleepInterruptible(220, token);
    if (!settleAlive) {
      return 'aborted';
    }
    if (await this.checkForRestrictionAndTripIfFound()) {
      return 'aborted';
    }
    return 'committed';
  }

  private async pauseWithReason(targetUsername: string | undefined, reason: string): Promise<void> {
    clearFallbackSession();
    this.runToken += 1;
    this.isLoopActive = false;
    this.cancelTimers();

    await this.patchRunnerState({
      state: 'paused',
      currentTarget: targetUsername,
      countdownSec: 0,
      sessionUnfollowedCount: this.sessionUnfollowedCount,
      statusText: reason,
    });
  }

  /**
   * Exits the loop because the extension/native store could not be reached. Reports a paused
   * state (when this loop still owns the run) instead of silently leaving "running" behind.
   */
  private async exitUnreachable(token: number, targetUsername?: string): Promise<void> {
    if (token !== this.runToken) {
      return;
    }
    await this.pauseWithReason(
      targetUsername,
      'Paused — could not read Chaos Tamer state. Reload the Instagram tab, then tap Resume.',
    );
  }

  private async executeLoop(
    token: number,
    preferredFirstTarget?: string,
    requireRunningStateOnBoot = false,
  ): Promise<void> {
    let pendingPreferredUsername = preferredFirstTarget?.toLowerCase();
    let verifyRunningOnBoot = requireRunningStateOnBoot;

    while (token === this.runToken && this.isLoopActive) {
      if (!hasContentRuntime()) {
        this.teardown();
        return;
      }

      if (await this.checkForRestrictionAndTripIfFound()) {
        return;
      }

      const state = await this.fetchFreshState(token);
      if (!state) {
        await this.exitUnreachable(token);
        return;
      }

      if (state.safety.emergencyStopReason) {
        this.abortCircuitBreaker(state.safety.emergencyStopReason);
        return;
      }

      if (verifyRunningOnBoot) {
        verifyRunningOnBoot = false;
        if (state.runner.state !== 'running') {
          // User clicked Stop or Pause while Profile Fallback navigation was in flight
          clearFallbackSession();
          this.releaseLoop(token);
          return;
        }
      }

      const queuedAccounts = getQueuedAccountsSorted(state);
      if (queuedAccounts.length === 0) {
        clearFallbackSession();
        this.runToken += 1;
        this.isLoopActive = false;
        this.cancelTimers();

        await this.patchRunnerState({
          state: 'idle',
          currentTarget: undefined,
          countdownSec: 0,
          sessionUnfollowedCount: this.sessionUnfollowedCount,
          statusText:
            this.sessionUnfollowedCount > 0
              ? `Queue complete — ${this.sessionUnfollowedCount} accounts unfollowed this session.`
              : 'Queue is empty — select accounts in the Following tab first.',
        });
        return;
      }

      const preferredMatch = pendingPreferredUsername
        ? queuedAccounts.find((item) => item.username === pendingPreferredUsername)
        : undefined;
      const targetAccount = preferredMatch ?? queuedAccounts[0];
      const isFallbackResumeForTarget = Boolean(
        preferredMatch && pendingPreferredUsername === targetAccount?.username,
      );
      pendingPreferredUsername = undefined;

      if (!targetAccount) {
        this.releaseLoop(token);
        return;
      }

      const rateSnapshot = evaluateRateLimit(state.safety, 'old_prune');
      if (!rateSnapshot.canAct) {
        const waitSec = Math.max(1, Math.ceil(rateSnapshot.nextSlotAvailableInMs / 1000));
        const survivedCooldown = await this.streamPerSecondCountdown(
          waitSec,
          'cooldown_paused',
          targetAccount.username,
          (sec) => `Rolling rate limit reached — cooling down (${formatDurationMmSs(sec * 1000)})`,
          token,
        );
        if (!survivedCooldown) {
          return;
        }

        const postCooldownState = await this.fetchFreshState(token);
        if (!postCooldownState) {
          await this.exitUnreachable(token, targetAccount.username);
          return;
        }
        if (!postCooldownState.safety.automationConfig.autoResumeAfterCooldown) {
          await this.pauseWithReason(
            targetAccount.username,
            'Cooldown elapsed — click Resume to continue Safe Auto-Unfollow.',
          );
          return;
        }
        continue;
      }

      // A long idle gap since the last action counts as a break of its own.
      const autoCfgNow = state.safety.automationConfig;
      const minBreakMs =
        Math.max(1, Math.min(autoCfgNow.breakMinMinutes, autoCfgNow.breakMaxMinutes)) * 60_000;
      if (this.lastCommittedAt > 0 && Date.now() - this.lastCommittedAt >= minBreakMs) {
        this.actionsSinceBreak = 0;
        this.pendingMicroBreak = false;
        this.nextActionNotBefore = 0;
      }

      // Honour the pacing scheduled after the previous unfollow (Gaussian delay or micro-break),
      // including right after this run was started or resumed.
      const pacingWaitMs = this.nextActionNotBefore - Date.now();
      if (pacingWaitMs > 0) {
        const isBreak = this.pendingMicroBreak;
        const survivedPacing = await this.streamPerSecondCountdown(
          Math.max(1, Math.ceil(pacingWaitMs / 1000)),
          isBreak ? 'micro_break' : 'running',
          targetAccount.username,
          (sec) =>
            isBreak
              ? `Batch micro-break (${this.sessionUnfollowedCount} unfollowed) — next @${targetAccount.username} in ${formatDurationMmSs(sec * 1000)}`
              : `Next unfollow (@${targetAccount.username}) in ${sec}s`,
          token,
        );
        if (!survivedPacing) {
          return;
        }
        if (isBreak) {
          this.actionsSinceBreak = 0;
          this.pendingMicroBreak = false;
        }
        this.nextActionNotBefore = 0;
        continue;
      }

      const acquisition = await this.acquireTargetButton(
        targetAccount,
        state.safety.automationConfig.profileFallback,
        isFallbackResumeForTarget,
        token,
      );

      if (acquisition.kind === 'aborted' || acquisition.kind === 'navigated_fallback') {
        this.releaseLoop(token);
        return;
      }

      if (acquisition.kind === 'paused_guidance') {
        await this.pauseWithReason(targetAccount.username, acquisition.message);
        return;
      }

      if (acquisition.kind === 'already_unfollowed') {
        await sendRuntimeMessage({
          type: 'SET_ACCOUNT_STATUS',
          username: targetAccount.username,
          status: targetAccount.intent === 'migrate' ? 'unfollowed_migrate' : 'unfollowed_dropped',
          recordTimestamp: false,
        });
        continue;
      }

      const outcome = await this.performSingleUnfollow(
        targetAccount,
        acquisition.button,
        acquisition.scrollTarget,
        acquisition.surface,
        token,
      );

      if (outcome !== 'committed') {
        return;
      }

      // Schedule humanized pacing for the NEXT action; the top of the loop waits it out after
      // re-reading state (empty queue → idle, breaker, rate limit).
      const postActionState = await this.fetchFreshState(token);
      if (!postActionState) {
        await this.exitUnreachable(token);
        return;
      }
      const autoCfg = postActionState.safety.automationConfig;
      const batchSize = Math.max(1, Math.round(autoCfg.batchSizeBeforeBreak));
      if (this.actionsSinceBreak >= batchSize) {
        const minMin = Math.min(autoCfg.breakMinMinutes, autoCfg.breakMaxMinutes);
        const maxMin = Math.max(autoCfg.breakMinMinutes, autoCfg.breakMaxMinutes);
        const breakSec = randomInt(
          Math.max(10, Math.round(minMin * 60)),
          Math.max(10, Math.round(maxMin * 60)),
        );
        this.pendingMicroBreak = true;
        this.nextActionNotBefore = Date.now() + breakSec * 1000;
      } else {
        const gaussianDelaySec = sampleTruncatedGaussianSec(
          autoCfg.minDelaySec,
          autoCfg.maxDelaySec,
        );
        this.pendingMicroBreak = false;
        this.nextActionNotBefore = Date.now() + gaussianDelaySec * 1000;
      }
    }
  }
}

export const autoUnfollowEngine = new AutoUnfollowEngine();
