import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');

async function importTsModule(relativePath, cacheBuster = '') {
  const entry = resolve(rootDir, relativePath);
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
  });
  const code = result.outputFiles[0].text + (cacheBuster ? `\n// ${cacheBuster}` : '');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(code, 'utf8').toString('base64')}`;
  return import(dataUrl);
}

/**
 * Minimal deterministic DOM shim for testing selectors.ts without external jsdom dependency.
 */
function installMinimalDom(pathname = '/') {
  class FakeNode {
    constructor(nodeType) {
      this.nodeType = nodeType;
      this.parentNode = null;
      this.childNodes = [];
    }
    get parentElement() {
      return this.parentNode instanceof FakeHTMLElement ? this.parentNode : null;
    }
    appendChild(child) {
      child.parentNode = this;
      this.childNodes.push(child);
      return child;
    }
    get textContent() {
      if (this.nodeType === 3) return this.nodeValue ?? '';
      return this.childNodes.map((c) => c.textContent).join('');
    }
    compareDocumentPosition(other) {
      const all = [];
      const walk = (n) => {
        all.push(n);
        for (const c of n.childNodes) walk(c);
      };
      walk(doc);
      const a = all.indexOf(this);
      const b = all.indexOf(other);
      if (a < 0 || b < 0 || a === b) return 0;
      return a < b ? 4 : 2; // 4 = DOCUMENT_POSITION_FOLLOWING
    }
  }

  class FakeTextNode extends FakeNode {
    constructor(text) {
      super(3);
      this.nodeValue = text;
    }
  }

  class FakeElement extends FakeNode {
    constructor(tagName) {
      super(1);
      this.tagName = tagName.toUpperCase();
      this.attrs = new Map();
      this._style = { display: 'block', visibility: 'visible', opacity: '1', position: 'static', overflowY: 'visible' };
      this._rect = { width: 320, height: 48, top: 0, left: 0, right: 320, bottom: 48 };
      this.scrollHeight = 48;
      this.clientHeight = 48;
      this.currentSrc = '';
    }
    get isConnected() {
      let cur = this;
      while (cur) {
        if (cur === doc) return true;
        cur = cur.parentNode;
      }
      return false;
    }
    get children() {
      return this.childNodes.filter((c) => c.nodeType === 1);
    }
    setAttribute(k, v) {
      this.attrs.set(k.toLowerCase(), String(v));
      return this;
    }
    getAttribute(k) {
      return this.attrs.has(k.toLowerCase()) ? this.attrs.get(k.toLowerCase()) : null;
    }
    matchesSelector(singleSel) {
      const s = singleSel.trim();
      if (!s) return false;
      const attrMatch = /^([a-zA-Z0-9_-]*)\[([a-zA-Z0-9_-]+)(?:="([^"]*)")?\]$/.exec(s);
      if (attrMatch) {
        const [, tagPart, attrName, attrVal] = attrMatch;
        if (tagPart && this.tagName !== tagPart.toUpperCase()) return false;
        const actual = this.getAttribute(attrName);
        if (actual === null) return false;
        return attrVal === undefined ? true : actual === attrVal;
      }
      return this.tagName === s.toUpperCase();
    }
    matches(selectorList) {
      return selectorList.split(',').some((part) => {
        const tokens = part.trim().split(/\s+/);
        if (tokens.length === 1) return this.matchesSelector(tokens[0]);
        if (!this.matchesSelector(tokens[tokens.length - 1])) return false;
        let anc = this.parentElement;
        let idx = tokens.length - 2;
        while (anc && idx >= 0) {
          if (anc.matchesSelector(tokens[idx])) idx -= 1;
          anc = anc.parentElement;
        }
        return idx < 0;
      });
    }
    closest(selectorList) {
      let cur = this;
      while (cur && cur instanceof FakeElement) {
        if (cur.matches(selectorList)) return cur;
        cur = cur.parentElement;
      }
      return null;
    }
    querySelectorAll(selectorList) {
      const results = [];
      const walk = (node) => {
        for (const child of node.childNodes) {
          if (child instanceof FakeElement) {
            if (child.matches(selectorList)) results.push(child);
            walk(child);
          }
        }
      };
      walk(this);
      return results;
    }
    querySelector(selectorList) {
      return this.querySelectorAll(selectorList)[0] ?? null;
    }
    getBoundingClientRect() {
      return this._rect;
    }
  }

  class FakeHTMLElement extends FakeElement {}

  const doc = new FakeNode(9);
  const html = new FakeHTMLElement('html');
  const body = new FakeHTMLElement('body');
  html._rect = { width: 390, height: 844, top: 0, left: 0, right: 390, bottom: 844 };
  html.clientHeight = 844;
  html.scrollHeight = 2400;
  body._rect = { width: 390, height: 844, top: 0, left: 0, right: 390, bottom: 844 };
  doc.appendChild(html);
  html.appendChild(body);

  doc.documentElement = html;
  doc.body = body;
  doc.scrollingElement = html;
  doc.querySelectorAll = (sel) => html.querySelectorAll(sel);
  doc.querySelector = (sel) => html.querySelector(sel);
  doc.createElement = (tag) => new FakeHTMLElement(tag);
  doc.createTextNode = (txt) => new FakeTextNode(txt);

  globalThis.Node = {
    TEXT_NODE: 3,
    ELEMENT_NODE: 1,
    DOCUMENT_POSITION_FOLLOWING: 4,
  };
  globalThis.Element = FakeElement;
  globalThis.HTMLElement = FakeHTMLElement;
  globalThis.document = doc;
  globalThis.window = {
    location: {
      origin: 'https://www.instagram.com',
      pathname,
    },
    getComputedStyle: (el) => el._style,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    addEventListener: () => {},
  };

  return { doc, html, body, el: (tag) => new FakeHTMLElement(tag), text: (t) => new FakeTextNode(t) };
}

test('selectors.ts: parses Mobile Web /<username>/following/ routes, excludes owner & nav links, and handles Persian ZWNJ', async () => {
  const dom = installMinimalDom('/mhrshadfm/following/');
  const selectors = await importTsModule('src/content/selectors.ts');

  assert.equal(selectors.parseFollowingListOwnerFromPath('/mhrshadfm/following/'), 'mhrshadfm');
  assert.equal(selectors.parseFollowingListOwnerFromPath('/explore/following/'), null);
  assert.equal(selectors.isFollowingListPagePath('/mhrshadfm/following'), true);
  assert.equal(selectors.isFollowingListPagePath('/mhrshadfm/'), false);

  // Persian ZWNJ + Arabic Yeh/Kaf normalization
  assert.equal(selectors.normalizeUiText('دنبال می‌كنيد'), 'دنبال میکنید');

  // Build Mobile Web full-page following list:
  // - <header> with back link to /mhrshadfm/ (owner)
  // - <main> with 2 real followed rows + Suggested section row
  const header = dom.el('header');
  const ownerBackLink = dom.el('a').setAttribute('href', '/mhrshadfm/');
  ownerBackLink.appendChild(dom.text('mhrshadfm'));
  header.appendChild(ownerBackLink);
  dom.body.appendChild(header);

  const main = dom.el('main');
  main._rect = { width: 390, height: 780, top: 44, left: 0, right: 390, bottom: 824 };
  dom.body.appendChild(main);

  const makeMobileRow = (username, displayName, buttonLabel, verified = false) => {
    const row = dom.el('div');
    row._rect = { width: 390, height: 64, top: 0, left: 0, right: 390, bottom: 64 };
    const link = dom.el('a').setAttribute('href', `/${username}/`);
    const img = dom.el('img').setAttribute('src', `https://cdn.ig/${username}.jpg`);
    link.appendChild(img);
    row.appendChild(link);

    const nameSpan = dom.el('span');
    nameSpan.appendChild(dom.text(displayName));
    row.appendChild(nameSpan);

    if (verified) {
      const svg = dom.el('svg').setAttribute('aria-label', 'تأیید شده');
      row.appendChild(svg);
    }

    const btn = dom.el('button');
    btn.appendChild(dom.text(buttonLabel));
    row.appendChild(btn);
    return row;
  };

  main.appendChild(makeMobileRow('natgeo', 'National Geographic', 'Following', true));
  main.appendChild(makeMobileRow('tehran_art', 'Tehran Art', 'دنبال می‌کنید', false));

  const suggestedHeader = dom.el('h3');
  suggestedHeader.appendChild(dom.text('Suggested for you'));
  main.appendChild(suggestedHeader);
  main.appendChild(makeMobileRow('random_suggested', 'Suggested User', 'Follow', false));

  const activeSurface = selectors.findActiveDialog('following_list');
  assert.equal(activeSurface, main, 'Should select <main> surface on Mobile /<user>/following/ route');

  const scrollTarget = selectors.findScrollableModalContainer(activeSurface);
  assert.equal(scrollTarget, dom.html, 'Should resolve document.scrollingElement when Mobile list scrolls window');

  const extracted = selectors.extractAccountsFromContainer(activeSurface);
  assert.equal(extracted.length, 2, 'Should extract 2 real followed accounts and skip owner + Suggested');
  assert.deepEqual(
    extracted.map((a) => ({ u: a.username, d: a.displayName, v: a.isVerified })),
    [
      { u: 'natgeo', d: 'National Geographic', v: true },
      { u: 'tehran_art', d: 'Tehran Art', v: false },
    ],
  );
});

test('selectors.ts: findProfileHeaderActionButton falls back from mobile top <header> to <main> and detects fixed bottom-sheet confirm', async () => {
  const dom = installMinimalDom('/target_creator/');
  const selectors = await importTsModule('src/content/selectors.ts', 'mobile-profile');

  // Mobile Instagram Web often renders a top navigation <header> WITHOUT the Follow/Following button,
  // placing the profile bio + relationship button inside <main> instead.
  const topNavHeader = dom.el('header');
  const backBtn = dom.el('button');
  backBtn.appendChild(dom.text('Back'));
  topNavHeader.appendChild(backBtn);
  dom.body.appendChild(topNavHeader);

  const main = dom.el('main');
  const profileSection = dom.el('section');
  const followingBtn = dom.el('button');
  followingBtn.appendChild(dom.text('Following'));
  profileSection.appendChild(followingBtn);
  main.appendChild(profileSection);
  dom.body.appendChild(main);

  const foundHeaderAction = selectors.findProfileHeaderActionButton(['following']);
  assert.ok(foundHeaderAction, 'Must fall back to <main> when top <header> has no relationship button');
  assert.equal(foundHeaderAction.kind, 'following');
  assert.equal(foundHeaderAction.button, followingBtn);

  // Mobile Web fixed bottom-sheet unfollow confirmation without role="dialog" (Persian "دنبال نکردن")
  const fixedSheet = dom.el('div');
  fixedSheet._style.position = 'fixed';
  const confirmBtn = dom.el('button');
  confirmBtn.appendChild(dom.text('دنبال نکردن'));
  fixedSheet.appendChild(confirmBtn);
  dom.body.appendChild(fixedSheet);

  const confirmResult = selectors.findConfirmationDialogWithButton();
  assert.ok(confirmResult, 'Should detect Mobile fixed bottom-sheet confirmation overlay');
  assert.equal(confirmResult.dialog, fixedSheet);
  assert.equal(confirmResult.confirmButton, confirmBtn);
});

test('runtimeBridge.ts: captures __ChaosTamerNativeContentBridge in closure, scrubs window global, and routes RPC/Push/Control', async () => {
  const sentPayloads = [];
  const fakePort = {
    onmessage: null,
    postMessage(str) {
      sentPayloads.push(JSON.parse(str));
    },
  };

  globalThis.window = {
    __ChaosTamerNativeContentBridge: fakePort,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  };
  delete globalThis.chrome;

  const runtimeBridge = await importTsModule('src/content/runtimeBridge.ts', 'native-content-port');

  assert.equal(
    '__ChaosTamerNativeContentBridge' in globalThis.window,
    false,
    'Must delete __ChaosTamerNativeContentBridge from window immediately at bootstrap',
  );
  assert.equal(runtimeBridge.hasContentRuntime(), true);
  assert.equal(sentPayloads.length, 1);
  assert.equal(sentPayloads[0].kind, 'CONTENT_READY');

  // Test Control message delivery
  const receivedControls = [];
  const unsubControl = runtimeBridge.subscribeContentControlMessages((ctrl) => {
    receivedControls.push(ctrl);
  });
  fakePort.onmessage({
    data: JSON.stringify({
      kind: 'CONTROL_MESSAGE',
      control: { type: 'CONTENT_SCRAPER_CONTROL', action: 'start' },
    }),
  });
  assert.deepEqual(receivedControls, [{ type: 'CONTENT_SCRAPER_CONTROL', action: 'start' }]);
  unsubControl();

  // Test RPC request/response roundtrip
  const rpcPromise = runtimeBridge.sendContentRuntimeMessage({
    type: 'PASSIVE_UNFOLLOW_DETECTED',
    username: 'old_account',
  });
  assert.equal(sentPayloads.length, 2);
  assert.equal(sentPayloads[1].kind, 'RPC_REQUEST');
  const rpcId = sentPayloads[1].id;

  fakePort.onmessage({
    data: JSON.stringify({
      kind: 'RPC_RESPONSE',
      id: rpcId,
      response: { ok: true },
    }),
  });
  const rpcRes = await rpcPromise;
  assert.equal(rpcRes.ok, true);
});

test('chromeBridge.ts & exporters.ts: routes Panel messages, state push subscriptions, and native Android Save/Share exports', async () => {
  const dispatchedMessages = [];
  const savedExports = [];
  const sharedExports = [];

  const mockNativeState = {
    schemaVersion: 1,
    theme: 'dark',
    includeFollowingInMigrate: false,
    accounts: {},
    safety: {
      accountMode: 'old_prune',
      unfollowTimestamps: [],
      followTimestamps: [],
      limits: {
        old_prune: { maxPerHour: 15, maxPerDay: 80 },
        new_warmup: { maxPerHour: 10, maxPerDay: 35 },
      },
      automationConfig: {
        minDelaySec: 28,
        maxDelaySec: 58,
        batchSizeBeforeBreak: 12,
        breakMinMinutes: 5,
        breakMaxMinutes: 8,
        profileFallback: false,
        autoResumeAfterCooldown: true,
      },
    },
    scraper: {
      scrollState: 'idle',
      extractedCount: 0,
      sessionNewCount: 0,
      stepCount: 0,
      retryCount: 0,
      statusText: 'Ready',
    },
    runner: {
      state: 'idle',
      countdownSec: 0,
      sessionUnfollowedCount: 0,
      statusText: 'Idle',
    },
  };

  globalThis.window = {
    ChaosTamerAndroidPanel: {
      getStateJson: () => JSON.stringify(mockNativeState),
      dispatchMessage: (msgJson) => {
        const parsed = JSON.parse(msgJson);
        dispatchedMessages.push(parsed);
        return JSON.stringify({ ok: true, state: mockNativeState });
      },
      saveExportFile: (filename, content, mimeType) => {
        savedExports.push({ filename, content, mimeType });
        return true;
      },
      shareExportFile: (filename, content, mimeType) => {
        sharedExports.push({ filename, content, mimeType });
        return true;
      },
    },
    addEventListener: () => {},
  };
  delete globalThis.chrome;

  const chromeBridge = await importTsModule('src/lib/chromeBridge.ts', 'android-panel-test');
  const exporters = await importTsModule('src/lib/exporters.ts', 'android-exporters-test');

  assert.equal(chromeBridge.isAndroidAppContext(), true);
  assert.equal(chromeBridge.isLiveHostContext(), true);
  assert.equal(typeof globalThis.window.__chaosTamerNotifyNativeState, 'function');

  const initial = await chromeBridge.getStorageState();
  assert.equal(initial.schemaVersion, 1);

  const pushedStates = [];
  const unsub = chromeBridge.subscribeStorageState((st) => pushedStates.push(st));
  globalThis.window.__chaosTamerNotifyNativeState(
    JSON.stringify({ ...mockNativeState, theme: 'light' }),
  );
  assert.equal(pushedStates.length, 1);
  assert.equal(pushedStates[0].theme, 'light');
  unsub();

  const res = await chromeBridge.sendExtensionMessage({ type: 'SET_THEME', theme: 'light' });
  assert.equal(res.ok, true);
  assert.deepEqual(dispatchedMessages, [{ type: 'SET_THEME', theme: 'light' }]);

  assert.equal(exporters.canShareExportNatively(), true);
  exporters.triggerFileDownload('chaos-tamer-backup.json', '{"ok":true}', 'application/json');
  assert.equal(savedExports.length, 1);
  assert.equal(savedExports[0].filename, 'chaos-tamer-backup.json');

  const shared = exporters.triggerNativeShareExport(
    'chaos-tamer-backup.json',
    '{"ok":true}',
    'application/json',
  );
  assert.equal(shared, true);
  assert.equal(sharedExports.length, 1);

  // Edge cases in validateAndNormalizeBackup
  assert.equal(exporters.validateAndNormalizeBackup('').valid, false);
  assert.equal(exporters.validateAndNormalizeBackup('{bad').valid, false);
  assert.equal(
    exporters.validateAndNormalizeBackup({ schemaVersion: 2, accounts: {} }).valid,
    false,
  );
  const validBackup = exporters.validateAndNormalizeBackup(
    exporters.serializeStateJson(mockNativeState),
  );
  assert.equal(validBackup.valid, true);
});

test('selectors.ts: detects ancestor overflow-y scroll wrapper around <main> and protects mobile profile Follow from bio @mentions', async () => {
  // 1. Mobile /<user>/following/ wrapped in an ancestor <div style="overflow-y: auto">
  const dom = installMinimalDom('/mhrshadfm/following/');
  dom.html.scrollHeight = 844; // window itself is NOT scrolling; ancestor wrapper owns scroll!
  const scrollWrapper = dom.el('div');
  scrollWrapper._style.overflowY = 'auto';
  scrollWrapper._rect = { width: 390, height: 780, top: 44, left: 0, right: 390, bottom: 824 };
  scrollWrapper.clientHeight = 780;
  scrollWrapper.scrollHeight = 3200;

  const main = dom.el('main');
  main._rect = { width: 390, height: 3200, top: 44, left: 0, right: 390, bottom: 3244 };
  const row = dom.el('div');
  const link = dom.el('a').setAttribute('href', '/natgeo/');
  const span = dom.el('span');
  span.appendChild(dom.text('National Geographic'));
  link.appendChild(span);
  row.appendChild(link);
  main.appendChild(row);
  scrollWrapper.appendChild(main);
  dom.body.appendChild(scrollWrapper);

  const selectors = await importTsModule('src/content/selectors.ts', 'ancestor-scroll-and-bio');
  const surface = selectors.findActiveDialog('following_list');
  assert.equal(surface, main);
  assert.equal(
    selectors.findScrollableModalContainer(surface),
    scrollWrapper,
    'Must detect ancestor overflow-y:auto wrapper above <main> when document.scrollingElement does not overflow',
  );

  // 2. Mobile profile /target_creator/ with <main><section> containing both a bio @other_handle link and Follow button
  const profileDom = installMinimalDom('/target_creator/');
  const profileMain = profileDom.el('main');
  const compactHeaderBox = profileDom.el('section');
  compactHeaderBox._rect = { width: 360, height: 84, top: 48, left: 0, right: 360, bottom: 132 };

  const bioMentionLink = profileDom.el('a').setAttribute('href', '/other_handle/');
  bioMentionLink.appendChild(profileDom.text('@other_handle'));
  compactHeaderBox.appendChild(bioMentionLink);

  const primaryFollowBtn = profileDom.el('button');
  primaryFollowBtn.appendChild(profileDom.text('Follow'));
  compactHeaderBox.appendChild(primaryFollowBtn);

  profileMain.appendChild(compactHeaderBox);
  profileDom.body.appendChild(profileMain);

  assert.equal(
    selectors.extractUsernameFromContext(primaryFollowBtn),
    'target_creator',
    'Primary profile button inside <main><section> must attribute to /target_creator/, not nearby bio @mention',
  );
});

test('runtimeBridge.ts & autoUnfollow.ts: serializes cleared undefined patch keys as null, aborts fallback on mid-nav Stop/Pause, and completes 2-step private unfollow', async () => {
  const dom = installMinimalDom('/private_friend/');
  const sessionStore = new Map();
  const sentMessages = [];

  let runnerBackendState = 'paused'; // Simulate user tapping Pause while Profile Fallback navigation was in flight

  const fakePort = {
    onmessage: null,
    postMessage(raw) {
      const env = JSON.parse(raw);
      if (env.kind !== 'RPC_REQUEST') return;
      sentMessages.push(env.message);

      if (env.message.type === 'GET_STATE') {
        fakePort.onmessage({
          data: JSON.stringify({
            kind: 'RPC_RESPONSE',
            id: env.id,
            response: {
              ok: true,
              state: {
                schemaVersion: 1,
                theme: 'dark',
                includeFollowingInMigrate: false,
                accounts: {
                  private_friend: {
                    username: 'private_friend',
                    displayName: 'Private Friend',
                    avatarUrl: '',
                    profileUrl: 'https://www.instagram.com/private_friend/',
                    isVerified: false,
                    status: 'queued_unfollow',
                    intent: 'migrate',
                    extractedAt: 1000,
                  },
                },
                safety: {
                  accountMode: 'old_prune',
                  unfollowTimestamps: [],
                  followTimestamps: [],
                  limits: {
                    old_prune: { maxPerHour: 15, maxPerDay: 80 },
                    new_warmup: { maxPerHour: 10, maxPerDay: 35 },
                  },
                  automationConfig: {
                    minDelaySec: 1,
                    maxDelaySec: 1,
                    batchSizeBeforeBreak: 12,
                    breakMinMinutes: 5,
                    breakMaxMinutes: 8,
                    profileFallback: true,
                    autoResumeAfterCooldown: true,
                  },
                },
                scraper: {
                  scrollState: 'idle',
                  extractedCount: 1,
                  sessionNewCount: 0,
                  stepCount: 0,
                  retryCount: 0,
                  statusText: 'Ready',
                },
                runner: {
                  state: runnerBackendState,
                  currentTarget: 'private_friend',
                  countdownSec: 0,
                  sessionUnfollowedCount: 0,
                  statusText: 'Paused',
                },
              },
            },
          }),
        });
        return;
      }

      fakePort.onmessage({
        data: JSON.stringify({
          kind: 'RPC_RESPONSE',
          id: env.id,
          response: { ok: true },
        }),
      });
    },
  };

  // Minimal event dispatch support on FakeHTMLElement for humanized click testing
  globalThis.MouseEvent = class FakeMouseEvent {
    constructor(type) {
      this.type = type;
    }
  };
  globalThis.PointerEvent = undefined;

  globalThis.window = {
    __ChaosTamerNativeContentBridge: fakePort,
    location: {
      origin: 'https://www.instagram.com',
      pathname: '/private_friend/',
      assign: () => {},
    },
    sessionStorage: {
      getItem: (k) => (sessionStore.has(k) ? sessionStore.get(k) : null),
      setItem: (k, v) => sessionStore.set(k, String(v)),
      removeItem: (k) => sessionStore.delete(k),
    },
    getComputedStyle: (el) => el._style,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    addEventListener: () => {},
  };
  delete globalThis.chrome;

  // Build profile header with Following button that triggers a 2-step Relationship Sheet -> Private Confirm Dialog
  const main = dom.el('main');
  const header = dom.el('header');
  const followingBtn = dom.el('button');
  const btnLabelNode = dom.text('Following');
  followingBtn.appendChild(btnLabelNode);
  followingBtn.scrollIntoView = () => {};
  header.appendChild(followingBtn);
  main.appendChild(header);
  dom.body.appendChild(main);

  let sheet1Clicks = 0;
  let dialog2Clicks = 0;

  followingBtn.dispatchEvent = (ev) => {
    if (ev.type !== 'click') return true;
    // Step 1: Mount Relationship Sheet #1 with an "Unfollow" option
    const sheet1 = dom.el('div').setAttribute('role', 'dialog');
    const unfollowOptionBtn = dom.el('button');
    unfollowOptionBtn.appendChild(dom.text('Unfollow'));
    unfollowOptionBtn.dispatchEvent = (innerEv) => {
      if (innerEv.type !== 'click') return true;
      sheet1Clicks += 1;
      // Remove Sheet #1 and mount Private Account Confirmation Dialog #2
      dom.body.childNodes = dom.body.childNodes.filter((n) => n !== sheet1);
      sheet1.parentNode = null;

      const confirmDialog2 = dom.el('div').setAttribute('role', 'dialog');
      const finalConfirmBtn = dom.el('button');
      finalConfirmBtn.appendChild(dom.text('Unfollow'));
      finalConfirmBtn.dispatchEvent = (finalEv) => {
        if (finalEv.type !== 'click') return true;
        dialog2Clicks += 1;
        dom.body.childNodes = dom.body.childNodes.filter((n) => n !== confirmDialog2);
        confirmDialog2.parentNode = null;
        btnLabelNode.nodeValue = 'Follow';
        return true;
      };
      confirmDialog2.appendChild(finalConfirmBtn);
      dom.body.appendChild(confirmDialog2);
      return true;
    };
    sheet1.appendChild(unfollowOptionBtn);
    dom.body.appendChild(sheet1);
    return true;
  };

  // Seed pending Profile Fallback session in sessionStorage
  sessionStore.set(
    'chaos_tamer_profile_fallback_v1',
    JSON.stringify({
      active: true,
      targetUsername: 'private_friend',
      sessionUnfollowedCount: 0,
      savedAt: Date.now(),
    }),
  );

  const autoMod = await importTsModule('src/content/autoUnfollow.ts', 'two-step-and-abort');

  // Part A: Since runnerBackendState === 'paused', resumeProfileFallbackIfPending MUST abort without clicking!
  autoMod.autoUnfollowEngine.resumeProfileFallbackIfPending();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(sheet1Clicks, 0, 'Must NOT click Following if user paused/stopped mid-navigation');
  assert.equal(
    sessionStore.has('chaos_tamer_profile_fallback_v1'),
    false,
    'Must clear stale fallback sessionStorage entry on mid-nav abort',
  );

  // Part B0 (v1.1.0): Stop/Pause are broadcast to EVERY Instagram tab, so an engine that owns no
  // run must stay silent instead of overwriting the state reported by the tab that does.
  const patchesBeforeIdleStop = sentMessages.filter((m) => m.type === 'RUNNER_STATE_PATCH').length;
  autoMod.autoUnfollowEngine.stop();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(
    sentMessages.filter((m) => m.type === 'RUNNER_STATE_PATCH').length,
    patchesBeforeIdleStop,
    'stop() on an idle engine (no run, no pending fallback hop) must not send a state patch',
  );

  // Part B: Verify stop() serializes currentTarget: undefined as null over the Android native bridge
  // (the engine owns a pending Profile Fallback hop here, so it reports the stop).
  sessionStore.set(
    'chaos_tamer_profile_fallback_v1',
    JSON.stringify({
      active: true,
      targetUsername: 'private_friend',
      sessionUnfollowedCount: 0,
      savedAt: Date.now(),
    }),
  );
  autoMod.autoUnfollowEngine.stop();
  await new Promise((r) => setTimeout(r, 20));
  const stopPatchMsg = sentMessages.find(
    (m) => m.type === 'RUNNER_STATE_PATCH' && m.patch && m.patch.state === 'idle',
  );
  assert.ok(stopPatchMsg, 'Expected idle RUNNER_STATE_PATCH on stop()');
  assert.equal(
    stopPatchMsg.patch.currentTarget,
    null,
    'undefined patch properties must serialize as null over native bridge so Kotlin removes them',
  );

  // Part C: Run 2-step unfollow end-to-end when runner is started
  runnerBackendState = 'running';
  autoMod.autoUnfollowEngine.start();

  const deadline = Date.now() + 7000;
  while (
    !sentMessages.some((m) => m.type === 'AUTO_UNFOLLOW_COMMITTED') &&
    Date.now() < deadline
  ) {
    await new Promise((r) => setTimeout(r, 120));
  }
  autoMod.autoUnfollowEngine.teardown();

  assert.equal(sheet1Clicks, 1, 'Should click Unfollow in Relationship Sheet #1');
  assert.equal(dialog2Clicks, 1, 'Should click Unfollow in Private Account Confirmation Dialog #2');
  assert.ok(
    sentMessages.some(
      (m) => m.type === 'AUTO_UNFOLLOW_COMMITTED' && m.username === 'private_friend',
    ),
    'Should commit AUTO_UNFOLLOW_COMMITTED only after 2nd confirmation dialog completes',
  );
});
