import type { AccountMode, StorageStateV1 } from '../types/schema';
import {
  autoUnfollowEngine,
  isRunnerSuppressingPassiveClicks,
  isSyntheticRunnerEvent,
} from './autoUnfollow';
import {
  hasContentRuntime,
  hydrateContentStateMirror,
  sendContentRuntimeMessage,
} from './runtimeBridge';
import { followingScraper } from './scraper';
import {
  classifyButtonLabel,
  detectRestrictionPhrase,
  extractUsernameFromContext,
  findAccountRowInContainer,
  findConfirmationDialogWithButton,
  findEnclosingConfirmationOverlay,
  findProfileHeaderActionButton,
  parseProfileUsernameFromPath,
} from './selectors';

const PENDING_UNFOLLOW_EXPIRY_MS = 15_000;
const FOLLOW_TRANSITION_TIMEOUT_MS = 2_500;
const FOLLOW_POLL_INTERVAL_MS = 150;
const CIRCUIT_DEDUPE_WINDOW_MS = 10_000;

interface PendingManualUnfollow {
  username: string;
  expiresAt: number;
}

interface ActiveFollowWatch {
  cleanup: () => void;
}

const sendRuntimeMessage = sendContentRuntimeMessage;

export class PassiveDomObserver {
  private started = false;
  private pendingTarget: PendingManualUnfollow | null = null;
  private pendingConfirmTimer: number | null = null;

  private cachedMode: AccountMode = 'old_prune';
  private knownUsernames = new Set<string>();
  private cacheHydrated = false;

  private restrictionObserver: MutationObserver | null = null;
  private activeFollowWatches = new Map<string, ActiveFollowWatch>();
  private unsubscribeStateMirror: (() => void) | null = null;

  private lastTrippedReason = '';
  private lastTrippedAt = 0;

  private readonly onDocumentClickCapture = (event: MouseEvent): void => {
    if (isSyntheticRunnerEvent(event) || isRunnerSuppressingPassiveClicks()) {
      return;
    }
    if (!(event.target instanceof Element)) {
      return;
    }

    const buttonEl = event.target.closest<HTMLElement>('button, [role="button"]');
    if (!buttonEl) {
      return;
    }

    const labelKind = classifyButtonLabel(buttonEl);
    if (!labelKind) {
      return;
    }

    if (labelKind === 'following' || labelKind === 'requested') {
      if (this.pendingConfirmTimer !== null) {
        window.clearTimeout(this.pendingConfirmTimer);
        this.pendingConfirmTimer = null;
      }
      const username = extractUsernameFromContext(buttonEl);
      if (username) {
        this.pendingTarget = {
          username: username.toLowerCase(),
          expiresAt: Date.now() + PENDING_UNFOLLOW_EXPIRY_MS,
        };
      }
      return;
    }

    if (labelKind === 'unfollow_confirm') {
      if (!findEnclosingConfirmationOverlay(buttonEl)) {
        return;
      }
      const now = Date.now();
      if (this.pendingTarget && now <= this.pendingTarget.expiresAt) {
        const confirmedUsername = this.pendingTarget.username;
        const clickedConfirmButton = buttonEl;
        this.pendingTarget.expiresAt = now + PENDING_UNFOLLOW_EXPIRY_MS;

        if (this.pendingConfirmTimer !== null) {
          window.clearTimeout(this.pendingConfirmTimer);
        }
        // Wait briefly to see whether Sheet #1 opened a 2nd private-account confirmation dialog
        this.pendingConfirmTimer = window.setTimeout(() => {
          this.pendingConfirmTimer = null;
          if (!this.started) {
            return;
          }
          const followUpConfirm = findConfirmationDialogWithButton();
          if (followUpConfirm && followUpConfirm.confirmButton !== clickedConfirmButton) {
            // Second confirmation dialog is open — wait for the user to confirm or cancel it.
            return;
          }
          if (this.pendingTarget?.username === confirmedUsername) {
            this.pendingTarget = null;
          }
          void sendRuntimeMessage({
            type: 'PASSIVE_UNFOLLOW_DETECTED',
            username: confirmedUsername,
          });
        }, 320);
      }
      return;
    }

    if (labelKind === 'follow') {
      const username = extractUsernameFromContext(buttonEl);
      if (!username) {
        return;
      }
      void this.handleFollowActionClick(username.toLowerCase(), buttonEl);
    }
  };

  public start(): void {
    if (this.started) {
      return;
    }
    this.started = true;

    document.addEventListener('click', this.onDocumentClickCapture, true);
    this.hydrateReadOnlyStateCache();
    this.startRestrictionObserver();

    const initialRestriction = detectRestrictionPhrase();
    if (initialRestriction) {
      this.tripCircuitBreaker(initialRestriction);
    }
  }

  public stop(): void {
    if (!this.started) {
      return;
    }
    this.started = false;

    document.removeEventListener('click', this.onDocumentClickCapture, true);

    if (this.pendingConfirmTimer !== null) {
      window.clearTimeout(this.pendingConfirmTimer);
      this.pendingConfirmTimer = null;
    }

    if (this.restrictionObserver) {
      this.restrictionObserver.disconnect();
      this.restrictionObserver = null;
    }

    for (const watch of this.activeFollowWatches.values()) {
      watch.cleanup();
    }
    this.activeFollowWatches.clear();

    if (this.unsubscribeStateMirror) {
      this.unsubscribeStateMirror();
      this.unsubscribeStateMirror = null;
    }
  }

  private applyStateSnapshot(state: StorageStateV1 | undefined): void {
    if (!state) {
      return;
    }
    this.cachedMode = state.safety?.accountMode ?? 'old_prune';
    this.knownUsernames = new Set(Object.keys(state.accounts ?? {}));
    this.cacheHydrated = true;
  }

  /**
   * Maintains a read-only in-memory mirror of `accountMode` and stored `accounts` keys.
   * Never writes directly to storage (all mutations pass through Background/Native mutex).
   */
  private hydrateReadOnlyStateCache(): void {
    this.unsubscribeStateMirror = hydrateContentStateMirror((state) => {
      this.applyStateSnapshot(state);
    });
  }

  private async shouldTrackFollowFor(username: string): Promise<boolean> {
    if (!this.cacheHydrated) {
      const res = await sendRuntimeMessage({ type: 'GET_STATE' });
      if (res.ok && res.state) {
        this.applyStateSnapshot(res.state);
      }
    }
    return this.cachedMode === 'new_warmup' || this.knownUsernames.has(username);
  }

  private async handleFollowActionClick(
    username: string,
    clickedButton: HTMLElement,
  ): Promise<void> {
    const enclosingDialog = clickedButton.closest<HTMLElement>('div[role="dialog"], [aria-modal="true"]');
    const enclosingHeader = clickedButton.closest<HTMLElement>('header');
    const enclosingMain = clickedButton.closest<HTMLElement>('main');
    const fallbackScope = clickedButton.parentElement ?? document.body;
    const watchRoot: HTMLElement =
      enclosingDialog ?? enclosingHeader ?? enclosingMain ?? fallbackScope;

    const eligible = await this.shouldTrackFollowFor(username);
    if (!eligible || !this.started) {
      return;
    }

    const previousWatch = this.activeFollowWatches.get(username);
    if (previousWatch) {
      previousWatch.cleanup();
      this.activeFollowWatches.delete(username);
    }

    const checkFlippedState = (): 'following' | 'requested' | null => {
      if (clickedButton.isConnected) {
        const directState = classifyButtonLabel(clickedButton);
        if (directState === 'following' || directState === 'requested') {
          return directState;
        }
      }

      if (enclosingDialog && enclosingDialog.isConnected) {
        const rowMatch = findAccountRowInContainer(enclosingDialog, username);
        if (rowMatch?.buttonKind === 'following' || rowMatch?.buttonKind === 'requested') {
          return rowMatch.buttonKind;
        }
      }

      const currentPathUser = parseProfileUsernameFromPath(window.location.pathname);
      if (currentPathUser === username) {
        const headerMatch = findProfileHeaderActionButton(['following', 'requested']);
        if (headerMatch?.kind === 'following' || headerMatch?.kind === 'requested') {
          return headerMatch.kind;
        }
      }

      return null;
    };

    const immediateFlip = checkFlippedState();
    if (immediateFlip) {
      await sendRuntimeMessage({
        type: 'PASSIVE_FOLLOW_DETECTED',
        username,
        requested: immediateFlip === 'requested',
      });
      return;
    }

    let settled = false;
    let pollTimer: number | null = null;
    let timeoutTimer: number | null = null;
    let mutationObs: MutationObserver | null = null;

    const cleanup = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (pollTimer !== null) {
        window.clearInterval(pollTimer);
        pollTimer = null;
      }
      if (timeoutTimer !== null) {
        window.clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      if (mutationObs) {
        mutationObs.disconnect();
        mutationObs = null;
      }
      this.activeFollowWatches.delete(username);
    };

    const evaluateAndCommit = (): void => {
      if (settled) {
        return;
      }
      const flipped = checkFlippedState();
      if (!flipped) {
        return;
      }
      cleanup();
      void sendRuntimeMessage({
        type: 'PASSIVE_FOLLOW_DETECTED',
        username,
        requested: flipped === 'requested',
      });
    };

    if (watchRoot.isConnected) {
      mutationObs = new MutationObserver(() => {
        evaluateAndCommit();
      });
      mutationObs.observe(watchRoot, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['aria-label'],
      });
    }

    pollTimer = window.setInterval(() => {
      evaluateAndCommit();
    }, FOLLOW_POLL_INTERVAL_MS);

    timeoutTimer = window.setTimeout(() => {
      evaluateAndCommit();
      cleanup();
    }, FOLLOW_TRANSITION_TIMEOUT_MS);

    this.activeFollowWatches.set(username, { cleanup });
  }

  private startRestrictionObserver(): void {
    if (this.restrictionObserver) {
      this.restrictionObserver.disconnect();
    }

    const targetRoot = document.documentElement;
    if (!targetRoot) {
      return;
    }

    this.restrictionObserver = new MutationObserver((mutations) => {
      if (!hasContentRuntime()) {
        this.stop();
        return;
      }

      for (let i = 0; i < mutations.length; i += 1) {
        const mutation = mutations[i];
        if (!mutation) {
          continue;
        }

        const added = mutation.addedNodes;
        for (let j = 0; j < added.length; j += 1) {
          const node = added[j];
          if (!node) {
            continue;
          }

          if (node.nodeType === Node.ELEMENT_NODE) {
            const el = node as HTMLElement;
            const tag = el.tagName.toUpperCase(); // SVG elements report a lowercase tagName
            if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'SVG') {
              continue;
            }
            if (el.closest('article')) {
              continue;
            }
            const reason = detectRestrictionPhrase(el);
            if (reason) {
              this.tripCircuitBreaker(reason);
              return;
            }
          } else if (node.nodeType === Node.TEXT_NODE && node.parentElement) {
            const alertOrDialog = node.parentElement.closest<HTMLElement>(
              'div[role="dialog"], [role="alert"], [aria-live]',
            );
            if (alertOrDialog) {
              const reason = detectRestrictionPhrase(alertOrDialog);
              if (reason) {
                this.tripCircuitBreaker(reason);
                return;
              }
            }
          }
        }
      }
    });

    this.restrictionObserver.observe(targetRoot, {
      childList: true,
      subtree: true,
    });
  }

  private tripCircuitBreaker(reason: string): void {
    const now = Date.now();
    if (
      reason === this.lastTrippedReason &&
      now - this.lastTrippedAt < CIRCUIT_DEDUPE_WINDOW_MS
    ) {
      return;
    }
    this.lastTrippedReason = reason;
    this.lastTrippedAt = now;

    followingScraper.stop();
    autoUnfollowEngine.abortCircuitBreaker(reason);

    void sendRuntimeMessage({
      type: 'TRIP_CIRCUIT_BREAKER',
      reason,
    });
  }
}

export const passiveObserver = new PassiveDomObserver();
