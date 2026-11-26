import { STORAGE_KEY } from '../lib/constants';
import type { BridgeResponse, ContentTabMessage, ExtensionMessage } from '../types/messages';
import type { StorageStateV1 } from '../types/schema';

interface WebMessageEventLike {
  data?: unknown;
}

interface AndroidWebMessagePortLike {
  postMessage: (payload: string) => void;
  onmessage: ((event: WebMessageEventLike) => void) | null;
}

interface PendingRpcEntry {
  resolve: (res: BridgeResponse) => void;
  timer: number;
}

type ControlMessageListener = (msg: ContentTabMessage) => void;
type StateChangeListener = (state: StorageStateV1) => void;

const RPC_TIMEOUT_MS = 15_000;

let capturedAndroidPort: AndroidWebMessagePortLike | null = null;
let rpcCounter = 0;
const pendingRpcs = new Map<string, PendingRpcEntry>();
const controlListeners = new Set<ControlMessageListener>();
const stateListeners = new Set<StateChangeListener>();
let latestAndroidState: StorageStateV1 | undefined;

function isValidControlAction(value: unknown): value is 'start' | 'pause' | 'resume' | 'stop' {
  return value === 'start' || value === 'pause' || value === 'resume' || value === 'stop';
}

export function isContentTabMessage(raw: unknown): raw is ContentTabMessage {
  if (typeof raw !== 'object' || raw === null) {
    return false;
  }
  const candidate = raw as { type?: unknown; action?: unknown };
  if (
    candidate.type !== 'CONTENT_SCRAPER_CONTROL' &&
    candidate.type !== 'CONTENT_RUNNER_CONTROL'
  ) {
    return false;
  }
  return isValidControlAction(candidate.action);
}

function bootstrapAndroidBridgeIfPresent(): void {
  if (typeof window === 'undefined') {
    return;
  }
  const rawWin = window as unknown as Record<string, unknown>;
  const candidate = rawWin.__ChaosTamerNativeContentBridge as AndroidWebMessagePortLike | undefined;
  if (!candidate || typeof candidate.postMessage !== 'function') {
    return;
  }

  // Capture inside private closure and immediately scrub from window before page scripts execute.
  capturedAndroidPort = candidate;
  try {
    delete rawWin.__ChaosTamerNativeContentBridge;
  } catch {
    rawWin.__ChaosTamerNativeContentBridge = undefined;
  }

  capturedAndroidPort.onmessage = (event: WebMessageEventLike): void => {
    if (typeof event?.data !== 'string') {
      return;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(event.data) as Record<string, unknown>;
    } catch {
      return;
    }

    const kind = parsed.kind;
    if (kind === 'RPC_RESPONSE' && typeof parsed.id === 'string') {
      const pending = pendingRpcs.get(parsed.id);
      if (!pending) {
        return;
      }
      pendingRpcs.delete(parsed.id);
      window.clearTimeout(pending.timer);
      const response = (parsed.response as BridgeResponse | undefined) ?? { ok: true };
      if (response.state && response.state.schemaVersion === 1) {
        latestAndroidState = response.state;
      }
      pending.resolve(response);
      return;
    }

    if (kind === 'CONTROL_MESSAGE' && isContentTabMessage(parsed.control)) {
      for (const listener of controlListeners) {
        try {
          listener(parsed.control);
        } catch {
          // Ignore individual listener failures
        }
      }
      return;
    }

    if (kind === 'STATE_PUSH' && typeof parsed.state === 'object' && parsed.state !== null) {
      const nextState = parsed.state as StorageStateV1;
      if (nextState.schemaVersion === 1) {
        latestAndroidState = nextState;
        for (const listener of stateListeners) {
          try {
            listener(nextState);
          } catch {
            // Ignore individual listener failures
          }
        }
      }
    }
  };

  try {
    capturedAndroidPort.postMessage(JSON.stringify({ kind: 'CONTENT_READY' }));
  } catch {
    // Ignore handshake errors during teardown
  }
}

bootstrapAndroidBridgeIfPresent();

export function isNativeAndroidContentHost(): boolean {
  return capturedAndroidPort !== null;
}

export function hasContentRuntime(): boolean {
  if (capturedAndroidPort !== null) {
    return true;
  }
  return typeof chrome !== 'undefined' && Boolean(chrome.runtime?.id);
}

function serializeMessageForNativeBridge(msg: ExtensionMessage): unknown {
  if (msg.type === 'RUNNER_STATE_PATCH' || msg.type === 'SCRAPER_STATE_PATCH') {
    const serializedPatch: Record<string, unknown> = {};
    const patchRecord = msg.patch as Record<string, unknown>;
    for (const key of Object.keys(patchRecord)) {
      const val = patchRecord[key];
      serializedPatch[key] = val === undefined ? null : val;
    }
    return {
      ...msg,
      patch: serializedPatch,
    };
  }
  return msg;
}

export async function sendContentRuntimeMessage(msg: ExtensionMessage): Promise<BridgeResponse> {
  if (capturedAndroidPort !== null) {
    const port = capturedAndroidPort;
    return new Promise<BridgeResponse>((resolve) => {
      rpcCounter += 1;
      const id = `ct_rpc_${rpcCounter}_${Date.now()}`;
      const timer = window.setTimeout(() => {
        pendingRpcs.delete(id);
        resolve({ ok: false, error: 'Native Android bridge request timed out.' });
      }, RPC_TIMEOUT_MS);

      pendingRpcs.set(id, { resolve, timer });
      try {
        port.postMessage(
          JSON.stringify({
            kind: 'RPC_REQUEST',
            id,
            message: serializeMessageForNativeBridge(msg),
          }),
        );
      } catch (err) {
        pendingRpcs.delete(id);
        window.clearTimeout(timer);
        resolve({
          ok: false,
          error: err instanceof Error ? err.message : 'Native bridge postMessage failed.',
        });
      }
    });
  }

  if (typeof chrome === 'undefined' || !chrome.runtime?.id) {
    return { ok: false, error: 'Extension runtime unavailable' };
  }

  try {
    const response = (await chrome.runtime.sendMessage(msg)) as BridgeResponse | undefined;
    return response ?? { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Message dispatch failed';
    return { ok: false, error: message };
  }
}

export function subscribeContentControlMessages(listener: ControlMessageListener): () => void {
  if (capturedAndroidPort !== null) {
    controlListeners.add(listener);
    return () => {
      controlListeners.delete(listener);
    };
  }

  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
    const chromeHandler = (
      message: unknown,
      _sender: chrome.runtime.MessageSender,
      sendResponse: (response?: BridgeResponse) => void,
    ): boolean => {
      if (!isContentTabMessage(message)) {
        return false;
      }
      listener(message);
      sendResponse({ ok: true });
      return false;
    };
    chrome.runtime.onMessage.addListener(chromeHandler);
    return () => {
      try {
        chrome.runtime.onMessage.removeListener(chromeHandler);
      } catch {
        // Ignore invalidated extension context
      }
    };
  }

  return () => undefined;
}

export function hydrateContentStateMirror(onState: StateChangeListener): () => void {
  if (capturedAndroidPort !== null) {
    if (latestAndroidState) {
      onState(latestAndroidState);
    } else {
      void sendContentRuntimeMessage({ type: 'GET_STATE' }).then((res) => {
        if (res.ok && res.state) {
          onState(res.state);
        }
      });
    }
    stateListeners.add(onState);
    return () => {
      stateListeners.delete(onState);
    };
  }

  if (typeof chrome === 'undefined' || !chrome.runtime?.id || !chrome.storage?.local) {
    return () => undefined;
  }

  chrome.storage.local.get(STORAGE_KEY, (items) => {
    if (chrome.runtime.lastError) {
      return;
    }
    const raw = items?.[STORAGE_KEY] as StorageStateV1 | undefined;
    if (raw) {
      onState(raw);
    }
  });

  const storageListener = (
    changes: { [key: string]: chrome.storage.StorageChange },
    areaName: string,
  ): void => {
    if (areaName !== 'local') {
      return;
    }
    const entry = changes[STORAGE_KEY];
    if (entry && entry.newValue) {
      onState(entry.newValue as StorageStateV1);
    }
  };

  chrome.storage.onChanged.addListener(storageListener);
  return () => {
    try {
      chrome.storage.onChanged.removeListener(storageListener);
    } catch {
      // Ignore invalidated extension context during teardown
    }
  };
}
