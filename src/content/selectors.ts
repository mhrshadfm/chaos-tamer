import type { ScrapedAccountInput } from '../types/schema';

export type ButtonSemanticKind = 'following' | 'requested' | 'unfollow_confirm' | 'follow';

/**
 * Normalized bilingual label sets (English + Persian).
 * All entries are pre-normalized with `normalizeUiText` (lowercase, unified Persian Yeh/Kaf, ZWNJ stripped).
 */
export const FOLLOWING_STATE_LABELS = ['following', 'دنبال میکنید'] as const;

export const REQUESTED_STATE_LABELS = ['requested', 'درخواست شده'] as const;

export const UNFOLLOW_CONFIRM_LABELS = ['unfollow', 'لغو دنبال کردن', 'دنبال نکردن'] as const;

export const FOLLOW_ACTION_LABELS = [
  'follow',
  'follow back',
  'دنبال کردن',
  'دنبال کردن متقابل',
] as const;

export const RESTRICTION_PHRASES = [
  'try again later',
  'we restrict certain activity',
  'feedback_required',
  // Persian "Try again later" / "we restrict certain activity". The bare word "تلاش مجدد" (Retry)
  // used to be listed here, but Instagram shows it on ordinary failed-to-load placeholders, which
  // tripped the emergency breaker without any real restriction.
  'بعدا دوباره امتحان کنید',
  'بعدا دوباره تلاش کنید',
  'محدود کردهایم',
  'محدود میکنیم',
] as const;

export const VERIFIED_BADGE_LABELS = ['verified', 'تایید شده', 'تأیید شده'] as const;

const SUGGESTED_SECTION_LABELS = [
  'suggested for you',
  'suggestions for you',
  'پیشنهاد برای شما',
  'پیشنهادشده برای شما',
] as const;

export const PROFILE_PATH_REGEX = /^\/([a-zA-Z0-9._]{1,30})\/?$/;
export const FOLLOWING_LIST_PATH_REGEX = /^\/([a-zA-Z0-9._]{1,30})\/following\/?$/;

export const RESERVED_PATHS: ReadonlySet<string> = new Set([
  'explore',
  'reels',
  'stories',
  'direct',
  'p',
  'reel',
  'tv',
  'accounts',
  'challenge',
  'about',
  'legal',
  'privacy',
  'session',
  'directory',
]);

/**
 * Normalizes UI strings across English and Persian so Arabic/Persian character variants
 * and Zero-Width Non-Joiners match deterministically.
 */
export function normalizeUiText(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\u064a/g, '\u06cc')
    .replace(/\u0643/g, '\u06a9')
    .replace(/[\u200c\u200f\u200e\ufeff\u064b-\u0652]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parses a valid Instagram username (lowercased) from a URL pathname, excluding reserved app routes.
 */
export function parseProfileUsernameFromPath(pathname: string): string | null {
  const match = PROFILE_PATH_REGEX.exec(pathname);
  if (!match || !match[1]) {
    return null;
  }
  const candidate = match[1].toLowerCase();
  if (RESERVED_PATHS.has(candidate)) {
    return null;
  }
  return candidate;
}

/**
 * Parses the profile owner username when viewing Mobile Web's full-page `/<username>/following/` route.
 */
export function parseFollowingListOwnerFromPath(
  pathname: string = window.location.pathname,
): string | null {
  const match = FOLLOWING_LIST_PATH_REGEX.exec(pathname);
  if (!match || !match[1]) {
    return null;
  }
  const candidate = match[1].toLowerCase();
  if (RESERVED_PATHS.has(candidate)) {
    return null;
  }
  return candidate;
}

export function isFollowingListPagePath(pathname: string = window.location.pathname): boolean {
  return parseFollowingListOwnerFromPath(pathname) !== null;
}

/**
 * Parses a valid Instagram username from a relative or absolute anchor `href` attribute.
 */
export function parseProfileUsernameFromHref(rawHref: string | null | undefined): string | null {
  if (!rawHref) {
    return null;
  }
  const trimmed = rawHref.trim();
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('javascript:')) {
    return null;
  }

  try {
    const resolved = new URL(trimmed, window.location.origin);
    const isInstagramHost =
      resolved.origin === window.location.origin ||
      resolved.hostname === 'www.instagram.com' ||
      resolved.hostname === 'instagram.com';
    if (!isInstagramHost) {
      return null;
    }
    return parseProfileUsernameFromPath(resolved.pathname);
  } catch {
    return parseProfileUsernameFromPath(trimmed);
  }
}

/**
 * Checks whether an HTMLElement is mounted and visually rendered on screen.
 */
export function isElementVisible(el: HTMLElement): boolean {
  if (!el.isConnected) {
    return false;
  }
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
    return false;
  }
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

const IGNORED_TEXT_TAGS = new Set(['SVG', 'TITLE', 'SCRIPT', 'STYLE', 'NOSCRIPT']);

/**
 * Extracts human-visible text from an element while skipping embedded SVG titles and script/style tags.
 */
export function getCleanElementText(el: Element): string {
  const chunks: string[] = [];

  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const value = node.nodeValue;
      if (value && value.trim().length > 0) {
        chunks.push(value);
      }
      return;
    }
    if (node.nodeType === Node.ELEMENT_NODE) {
      const elem = node as Element;
      if (IGNORED_TEXT_TAGS.has(elem.tagName.toUpperCase())) {
        return;
      }
      if (elem.getAttribute('aria-hidden') === 'true') {
        return;
      }
      const children = elem.childNodes;
      for (let i = 0; i < children.length; i += 1) {
        const child = children[i];
        if (child) {
          walk(child);
        }
      }
    }
  };

  walk(el);
  return chunks.join(' ').replace(/\s+/g, ' ').trim();
}

function matchesLabelList(normalizedText: string, labels: readonly string[]): boolean {
  for (const label of labels) {
    if (normalizedText === label) {
      return true;
    }
  }
  return false;
}

/**
 * Classifies a button or `[role="button"]` element by its normalized English or Persian UI label.
 */
export function classifyButtonLabel(el: HTMLElement): ButtonSemanticKind | null {
  const cleanText = normalizeUiText(getCleanElementText(el));
  const ariaText = normalizeUiText(el.getAttribute('aria-label') ?? '');
  const candidates = cleanText ? [cleanText, ariaText] : [ariaText];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    if (matchesLabelList(candidate, FOLLOWING_STATE_LABELS)) {
      return 'following';
    }
    if (matchesLabelList(candidate, REQUESTED_STATE_LABELS)) {
      return 'requested';
    }
    if (matchesLabelList(candidate, UNFOLLOW_CONFIRM_LABELS)) {
      return 'unfollow_confirm';
    }
    if (matchesLabelList(candidate, FOLLOW_ACTION_LABELS)) {
      return 'follow';
    }
  }

  return null;
}

function collectDistinctProfileUsernames(root: ParentNode): Set<string> {
  const usernames = new Set<string>();
  const anchors = root.querySelectorAll<HTMLAnchorElement>('a[href]');
  for (let i = 0; i < anchors.length; i += 1) {
    const anchor = anchors[i];
    if (!anchor) {
      continue;
    }
    if (anchor.closest('header, nav')) {
      continue;
    }
    const username = parseProfileUsernameFromHref(anchor.getAttribute('href'));
    if (username) {
      usernames.add(username);
    }
  }
  return usernames;
}

function dialogHasUnfollowConfirmButton(dialog: HTMLElement): boolean {
  const buttons = dialog.querySelectorAll<HTMLElement>('button, [role="button"]');
  for (let i = 0; i < buttons.length; i += 1) {
    const btn = buttons[i];
    if (btn && isElementVisible(btn) && classifyButtonLabel(btn) === 'unfollow_confirm') {
      return true;
    }
  }
  return false;
}

/**
 * Resolves the enclosing modal dialog or Mobile Web fixed bottom-sheet confirmation overlay for `el`.
 */
export function findEnclosingConfirmationOverlay(el: HTMLElement): HTMLElement | null {
  const dialogOrModal = el.closest<HTMLElement>('div[role="dialog"], [aria-modal="true"]');
  if (dialogOrModal && isElementVisible(dialogOrModal)) {
    return dialogOrModal;
  }

  let curr: HTMLElement | null = el.parentElement;
  while (curr && curr !== document.body && curr !== document.documentElement) {
    const tag = curr.tagName;
    if (tag === 'MAIN' || tag === 'HEADER' || tag === 'NAV' || tag === 'ARTICLE') {
      return null;
    }
    if (isElementVisible(curr) && window.getComputedStyle(curr).position === 'fixed') {
      return curr;
    }
    curr = curr.parentElement;
  }
  return null;
}

/**
 * Selects an active visible `div[role="dialog"]` (or Mobile Web's `/<username>/following/` `<main>` surface).
 * When `mode === 'following_list'` (default), prefers the Following list dialog containing profile rows
 * over any stacked confirmation dialog. When `mode === 'confirmation'`, prefers the topmost confirmation dialog.
 */
export function findActiveDialog(
  mode: 'following_list' | 'confirmation' = 'following_list',
): HTMLElement | null {
  const dialogs = Array.from(
    document.querySelectorAll<HTMLElement>('div[role="dialog"], [aria-modal="true"]'),
  ).filter(isElementVisible);

  if (mode === 'confirmation') {
    for (let i = dialogs.length - 1; i >= 0; i -= 1) {
      const dialog = dialogs[i];
      if (dialog && dialogHasUnfollowConfirmButton(dialog)) {
        return dialog;
      }
    }
    const mobileConfirm = findConfirmationDialogWithButton();
    if (mobileConfirm) {
      return mobileConfirm.dialog;
    }
    return dialogs[dialogs.length - 1] ?? null;
  }

  if (dialogs.length > 0) {
    let bestDialog: HTMLElement | null = null;
    let bestScore = -1;

    for (const dialog of dialogs) {
      if (dialogHasUnfollowConfirmButton(dialog) && dialogs.length > 1) {
        continue;
      }
      const profileCount = collectDistinctProfileUsernames(dialog).size;
      const hasProgress = dialog.querySelector('[role="progressbar"]') !== null;
      const score = profileCount * 10 + (hasProgress ? 3 : 0);

      if (score > bestScore && !dialogHasUnfollowConfirmButton(dialog)) {
        bestScore = score;
        bestDialog = dialog;
      }
    }

    if (bestDialog) {
      return bestDialog;
    }
    const firstNonConfirm = dialogs.find((d) => !dialogHasUnfollowConfirmButton(d));
    if (firstNonConfirm) {
      return firstNonConfirm;
    }
  }

  // Mobile Web fallback: full-page `/<username>/following/` route rendered inside <main> or <body> portal
  if (isFollowingListPagePath(window.location.pathname)) {
    const mainEl = document.querySelector<HTMLElement>('main');
    if (
      mainEl &&
      isElementVisible(mainEl) &&
      (collectDistinctProfileUsernames(mainEl).size >= 1 || hasVisibleProgressbar(mainEl))
    ) {
      return mainEl;
    }
    if (
      document.body &&
      isElementVisible(document.body) &&
      (extractAccountsFromContainer(document.body).length >= 1 || hasVisibleProgressbar(document.body))
    ) {
      return document.body;
    }
  }

  return dialogs[0] ?? null;
}

/**
 * Finds the topmost visible Unfollow confirmation dialog/sheet along with its confirm button.
 */
export function findConfirmationDialogWithButton(): {
  dialog: HTMLElement;
  confirmButton: HTMLElement;
} | null {
  const dialogs = Array.from(
    document.querySelectorAll<HTMLElement>('div[role="dialog"], [aria-modal="true"]'),
  ).filter(isElementVisible);
  for (let i = dialogs.length - 1; i >= 0; i -= 1) {
    const dialog = dialogs[i];
    if (!dialog) {
      continue;
    }
    const buttons = dialog.querySelectorAll<HTMLElement>('button, [role="button"]');
    for (let j = 0; j < buttons.length; j += 1) {
      const btn = buttons[j];
      if (btn && isElementVisible(btn) && classifyButtonLabel(btn) === 'unfollow_confirm') {
        return { dialog, confirmButton: btn };
      }
    }
  }

  // Mobile Web bottom-sheet fallback (fixed overlay portal without role="dialog")
  const allButtons = document.querySelectorAll<HTMLElement>('button, [role="button"]');
  for (let i = allButtons.length - 1; i >= 0; i -= 1) {
    const btn = allButtons[i];
    if (!btn || !isElementVisible(btn) || classifyButtonLabel(btn) !== 'unfollow_confirm') {
      continue;
    }
    const overlay = findEnclosingConfirmationOverlay(btn);
    if (overlay) {
      return { dialog: overlay, confirmButton: btn };
    }
  }

  return null;
}

/**
 * Traverses descendants of `dialog` to locate the scrollable Following list container.
 * Uses computed `overflowY` (`'auto'` or `'scroll'`) with `scrollHeight > clientHeight`,
 * falling back to overflow-enabled list wrappers or the tallest container holding >= 2 profile links.
 */
export function findScrollableModalContainer(dialog: HTMLElement): HTMLElement | null {
  const ancestorCandidates: HTMLElement[] = [];
  if (dialog.getAttribute('role') !== 'dialog') {
    let anc = dialog.parentElement;
    while (anc && anc !== document.documentElement) {
      ancestorCandidates.push(anc);
      if (anc === document.body) {
        break;
      }
      anc = anc.parentElement;
    }
  }

  const candidates = [
    dialog,
    ...Array.from(dialog.querySelectorAll<HTMLElement>('div, ul, section, main')),
    ...ancestorCandidates,
  ];

  let bestOverflowing: HTMLElement | null = null;
  let bestOverflowingScore = -1;

  let bestScrollStyled: HTMLElement | null = null;
  let bestScrollStyledScore = -1;

  let bestFallbackList: HTMLElement | null = null;
  let bestFallbackHeight = -1;

  for (const el of candidates) {
    if (!isElementVisible(el)) {
      continue;
    }
    const style = window.getComputedStyle(el);
    const overflowY = style.overflowY;
    const isScrollableStyle = overflowY === 'auto' || overflowY === 'scroll';
    const profileCount = collectDistinctProfileUsernames(el).size;
    const hasSpinner = el.querySelector('[role="progressbar"]') !== null;

    if (isScrollableStyle && el.scrollHeight > el.clientHeight + 2 && el.clientHeight > 40) {
      const score = profileCount * 100 + el.clientHeight + (hasSpinner ? 25 : 0);
      if (score > bestOverflowingScore) {
        bestOverflowingScore = score;
        bestOverflowing = el;
      }
    } else if (isScrollableStyle && el.clientHeight > 40 && (profileCount >= 1 || hasSpinner)) {
      const score = profileCount * 100 + el.clientHeight;
      if (score > bestScrollStyledScore) {
        bestScrollStyledScore = score;
        bestScrollStyled = el;
      }
    }

    if (el !== dialog && profileCount >= 2) {
      const height = Math.max(el.scrollHeight, el.clientHeight);
      if (height > bestFallbackHeight) {
        bestFallbackHeight = height;
        bestFallbackList = el;
      }
    }
  }

  if (bestOverflowing) {
    return bestOverflowing;
  }

  // Mobile Web full-page `/<username>/following/` route often scrolls document.scrollingElement directly
  if (dialog.getAttribute('role') !== 'dialog' && isFollowingListPagePath(window.location.pathname)) {
    const docScroller =
      (document.scrollingElement instanceof HTMLElement ? document.scrollingElement : null) ??
      document.documentElement;
    if (docScroller && docScroller.scrollHeight > docScroller.clientHeight + 2) {
      return docScroller;
    }
    return bestScrollStyled ?? docScroller ?? bestFallbackList;
  }

  return bestScrollStyled ?? bestFallbackList;
}

/**
 * Checks whether a loading spinner (`[role="progressbar"]`) is currently visible inside `root`.
 */
export function hasVisibleProgressbar(root: ParentNode): boolean {
  const spinners = root.querySelectorAll<HTMLElement>('[role="progressbar"]');
  for (let i = 0; i < spinners.length; i += 1) {
    const spinner = spinners[i];
    if (spinner && isElementVisible(spinner)) {
      return true;
    }
  }
  return false;
}

/**
 * Walks up from a profile anchor to isolate the single account row container within `boundary`.
 */
function resolveRowContainerForAnchor(
  anchor: HTMLAnchorElement,
  username: string,
  boundary: ParentNode,
): HTMLElement {
  let row: HTMLElement = anchor;
  let parent = anchor.parentElement;

  while (parent && parent !== boundary && parent !== document.body) {
    const usernamesInParent = collectDistinctProfileUsernames(parent);
    if (usernamesInParent.size > 1) {
      break;
    }
    if (usernamesInParent.size === 1 && !usernamesInParent.has(username)) {
      break;
    }

    const rect = parent.getBoundingClientRect();
    if (rect.height > 180) {
      break;
    }

    row = parent;

    if (parent.tagName === 'LI') {
      break;
    }

    const hasAvatar = parent.querySelector('img') !== null;
    const hasButton = parent.querySelector('button, [role="button"]') !== null;
    if (hasAvatar && hasButton && parent.parentElement === boundary) {
      break;
    }

    parent = parent.parentElement;
  }

  return row;
}

function findSuggestedBoundaryElement(root: ParentNode): HTMLElement | null {
  const elements = root.querySelectorAll<HTMLElement>('h2, h3, h4, span, div');
  for (let i = 0; i < elements.length; i += 1) {
    const el = elements[i];
    if (!el || el.children.length > 2) {
      continue;
    }
    const text = normalizeUiText(getCleanElementText(el));
    if (!text) {
      continue;
    }
    for (const label of SUGGESTED_SECTION_LABELS) {
      if (text === label) {
        return el;
      }
    }
  }
  return null;
}

function isAfterElementInDom(reference: HTMLElement | null, target: HTMLElement): boolean {
  if (!reference) {
    return false;
  }
  const relation = reference.compareDocumentPosition(target);
  return (relation & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

function extractVerifiedFromRow(row: HTMLElement): boolean {
  const svgs = row.querySelectorAll<SVGElement>('svg');
  for (let i = 0; i < svgs.length; i += 1) {
    const svg = svgs[i];
    if (!svg) {
      continue;
    }
    const aria = normalizeUiText(svg.getAttribute('aria-label') ?? '');
    const titleEl = svg.querySelector('title');
    const titleText = normalizeUiText(titleEl?.textContent ?? '');
    const combined = `${aria} ${titleText}`.trim();
    if (!combined) {
      continue;
    }
    for (const badge of VERIFIED_BADGE_LABELS) {
      if (combined.includes(badge)) {
        return true;
      }
    }
  }
  return false;
}

function extractAvatarUrlFromRow(row: HTMLElement): string {
  const images = row.querySelectorAll<HTMLImageElement>('img');
  for (let i = 0; i < images.length; i += 1) {
    const img = images[i];
    if (!img) {
      continue;
    }
    const src = (img.currentSrc || img.getAttribute('src') || '').trim();
    if (src && !src.startsWith('data:image/gif')) {
      return src;
    }
  }
  return '';
}

function extractDisplayNameFromRow(row: HTMLElement, username: string): string {
  const spans = row.querySelectorAll<HTMLElement>('span');
  for (let i = 0; i < spans.length; i += 1) {
    const span = spans[i];
    if (!span) {
      continue;
    }
    if (span.closest('button, [role="button"], a[href], svg')) {
      continue;
    }
    if (span.querySelector('a[href], button, [role="button"]')) {
      continue;
    }

    const childSpans = span.querySelectorAll('span');
    let hasMeaningfulChildSpan = false;
    for (let j = 0; j < childSpans.length; j += 1) {
      const child = childSpans[j];
      if (child && getCleanElementText(child).length > 0) {
        hasMeaningfulChildSpan = true;
        break;
      }
    }
    if (hasMeaningfulChildSpan) {
      continue;
    }

    const rawText = getCleanElementText(span).trim();
    if (!rawText) {
      continue;
    }
    const normalized = normalizeUiText(rawText);
    if (
      !normalized ||
      normalized === username ||
      normalized === `@${username}` ||
      normalized === '•' ||
      normalized === '·'
    ) {
      continue;
    }
    if (
      matchesLabelList(normalized, FOLLOWING_STATE_LABELS) ||
      matchesLabelList(normalized, REQUESTED_STATE_LABELS) ||
      matchesLabelList(normalized, UNFOLLOW_CONFIRM_LABELS) ||
      matchesLabelList(normalized, FOLLOW_ACTION_LABELS) ||
      matchesLabelList(normalized, VERIFIED_BADGE_LABELS)
    ) {
      continue;
    }
    if (
      normalized.startsWith('followed by ') ||
      normalized.startsWith('دنبال شده توسط ') ||
      matchesLabelList(normalized, SUGGESTED_SECTION_LABELS)
    ) {
      continue;
    }

    return rawText;
  }
  return '';
}

function findPrimaryButtonInRow(
  row: HTMLElement,
): { button: HTMLElement; kind: ButtonSemanticKind } | null {
  const buttons = row.querySelectorAll<HTMLElement>('button, [role="button"]');
  for (let i = 0; i < buttons.length; i += 1) {
    const btn = buttons[i];
    if (!btn || !isElementVisible(btn)) {
      continue;
    }
    const kind = classifyButtonLabel(btn);
    if (kind) {
      return { button: btn, kind };
    }
  }
  return null;
}

/**
 * Extracts mounted Instagram account rows from a modal or list container.
 * Deduplicates accounts within the container pass and normalizes usernames to lowercase.
 */
export function extractAccountsFromContainer(root: ParentNode): ScrapedAccountInput[] {
  const anchors = root.querySelectorAll<HTMLAnchorElement>('a[href]');
  const seen = new Map<string, ScrapedAccountInput>();
  const suggestedBoundary = findSuggestedBoundaryElement(root);
  const isDialogSurface =
    root instanceof HTMLElement &&
    (root.getAttribute('role') === 'dialog' || root.getAttribute('aria-modal') === 'true');
  const listOwner = isDialogSurface ? null : parseFollowingListOwnerFromPath(window.location.pathname);

  for (let i = 0; i < anchors.length; i += 1) {
    const anchor = anchors[i];
    if (!anchor) {
      continue;
    }
    if (anchor.closest('header, nav')) {
      continue;
    }

    const username = parseProfileUsernameFromHref(anchor.getAttribute('href'));
    if (!username || seen.has(username) || username === listOwner) {
      continue;
    }

    const row = resolveRowContainerForAnchor(anchor, username, root);
    if (row === anchor && anchor.querySelector('img, span') === null) {
      continue;
    }

    const rowAction = findPrimaryButtonInRow(row);
    if (rowAction?.kind === 'follow' && isAfterElementInDom(suggestedBoundary, row)) {
      continue;
    }

    const hasRowSignals =
      rowAction !== null ||
      row.querySelector('img') !== null ||
      row.querySelectorAll('span').length >= 1;
    if (!hasRowSignals) {
      continue;
    }

    const avatarUrl = extractAvatarUrlFromRow(row);
    const isVerified = extractVerifiedFromRow(row);
    const displayName = extractDisplayNameFromRow(row, username);

    seen.set(username, {
      username,
      displayName,
      avatarUrl,
      isVerified,
    });
  }

  return Array.from(seen.values());
}

/**
 * Locates a mounted row and its semantic action button for `targetUsername` inside `root`.
 */
export function findAccountRowInContainer(
  root: ParentNode,
  targetUsername: string,
): { row: HTMLElement; actionButton: HTMLElement | null; buttonKind: ButtonSemanticKind | null } | null {
  const normalizedTarget = targetUsername.trim().toLowerCase();
  const anchors = root.querySelectorAll<HTMLAnchorElement>('a[href]');

  for (let i = 0; i < anchors.length; i += 1) {
    const anchor = anchors[i];
    if (!anchor) {
      continue;
    }
    if (anchor.closest('header, nav')) {
      continue;
    }
    const username = parseProfileUsernameFromHref(anchor.getAttribute('href'));
    if (username !== normalizedTarget) {
      continue;
    }

    const row = resolveRowContainerForAnchor(anchor, username, root);
    if (!isElementVisible(row)) {
      continue;
    }
    const primary = findPrimaryButtonInRow(row);
    return {
      row,
      actionButton: primary?.button ?? null,
      buttonKind: primary?.kind ?? null,
    };
  }

  return null;
}

/**
 * Finds the primary relationship button inside a profile page `<header>` (or `<main>` fallback).
 */
export function findProfileHeaderActionButton(
  allowedKinds: ReadonlyArray<ButtonSemanticKind> = ['following', 'requested', 'follow'],
): { button: HTMLElement; kind: ButtonSemanticKind } | null {
  const mainEl = document.querySelector('main');
  const suggestedBoundary = mainEl ? findSuggestedBoundaryElement(mainEl) : null;
  const scopes: Array<ParentNode | null> = [
    document.querySelector('header'),
    document.querySelector('main header'),
    mainEl,
  ];

  for (const scope of scopes) {
    if (!scope) {
      continue;
    }
    const isMainFallback = scope === mainEl;
    const buttons = scope.querySelectorAll<HTMLElement>('button, [role="button"]');
    for (let i = 0; i < buttons.length; i += 1) {
      const btn = buttons[i];
      if (!btn || !isElementVisible(btn)) {
        continue;
      }
      if (btn.closest('div[role="dialog"], [aria-modal="true"], nav, article')) {
        continue;
      }
      if (isMainFallback && isAfterElementInDom(suggestedBoundary, btn)) {
        continue;
      }
      const kind = classifyButtonLabel(btn);
      if (kind && allowedKinds.includes(kind)) {
        return { button: btn, kind };
      }
    }
  }

  return null;
}

/**
 * Walks up ancestors inside a dialog/list row to find the associated profile `a[href]`,
 * or falls back to `window.location.pathname` when acting on a profile page header.
 */
export function extractUsernameFromContext(buttonEl: HTMLElement): string | null {
  const enclosingDialog = buttonEl.closest<HTMLElement>('div[role="dialog"], [aria-modal="true"]');
  if (enclosingDialog) {
    let curr: HTMLElement | null = buttonEl.parentElement;
    while (curr && curr !== enclosingDialog) {
      const usernames = collectDistinctProfileUsernames(curr);
      if (usernames.size === 1) {
        const iteratorResult = usernames.values().next();
        return iteratorResult.done ? null : iteratorResult.value;
      }
      if (usernames.size > 1) {
        break;
      }
      curr = curr.parentElement;
    }
  }

  const pathnameUsername = parseProfileUsernameFromPath(window.location.pathname);
  if (pathnameUsername) {
    if (buttonEl.closest('header')) {
      return pathnameUsername;
    }
    const primaryHeaderAction = findProfileHeaderActionButton();
    if (primaryHeaderAction && primaryHeaderAction.button === buttonEl) {
      return pathnameUsername;
    }
  }

  const maxRowHeight = pathnameUsername ? 96 : 220;
  let rowCandidate: HTMLElement | null = buttonEl.parentElement;
  let depth = 0;
  while (rowCandidate && rowCandidate !== document.body && depth < 8) {
    const rect = rowCandidate.getBoundingClientRect();
    if (rect.height > maxRowHeight) {
      break;
    }
    const usernames = collectDistinctProfileUsernames(rowCandidate);
    if (usernames.size === 1) {
      const iteratorResult = usernames.values().next();
      if (!iteratorResult.done) {
        return iteratorResult.value;
      }
    }
    if (usernames.size > 1) {
      break;
    }
    rowCandidate = rowCandidate.parentElement;
    depth += 1;
  }

  return pathnameUsername;
}

function matchRestrictionInText(rawText: string): string | null {
  if (!rawText) {
    return null;
  }
  const normalized = normalizeUiText(rawText);
  if (!normalized) {
    return null;
  }
  for (const phrase of RESTRICTION_PHRASES) {
    if (normalized.includes(phrase)) {
      return `Instagram restriction detected ("${phrase}")`;
    }
  }
  return null;
}

/**
 * Scans dialogs, alerts, live regions, or a specific added subtree for English or Persian
 * Instagram action-block / rate-limit restriction phrases.
 */
/**
 * Direct-message threads contain free text written by other people ("try again later" in a chat
 * must not trip the emergency breaker). No automation runs there, so restriction scanning is skipped.
 */
function isOnDirectMessagesRoute(): boolean {
  try {
    return /^\/direct(\/|$)/i.test(window.location.pathname);
  } catch {
    return false;
  }
}

export function detectRestrictionPhrase(root: ParentNode = document): string | null {
  if (isOnDirectMessagesRoute()) {
    return null;
  }
  if (root !== document) {
    if (root instanceof HTMLElement && root.closest('article')) {
      return null;
    }
    const text = root instanceof Element ? getCleanElementText(root) : (root.textContent ?? '');
    return matchRestrictionInText(text);
  }

  const priorityElements = document.querySelectorAll<HTMLElement>(
    'div[role="dialog"], [role="alert"], [aria-live="assertive"], [aria-live="polite"]',
  );
  for (let i = 0; i < priorityElements.length; i += 1) {
    const el = priorityElements[i];
    if (!el || !isElementVisible(el)) {
      continue;
    }
    const matched = matchRestrictionInText(getCleanElementText(el));
    if (matched) {
      return matched;
    }
  }

  if (document.body) {
    const bodyDialogsOrToasts = document.body.children;
    for (let i = 0; i < bodyDialogsOrToasts.length; i += 1) {
      const child = bodyDialogsOrToasts[i];
      if (!(child instanceof HTMLElement) || !isElementVisible(child)) {
        continue;
      }
      if (child.tagName === 'SCRIPT' || child.tagName === 'STYLE') {
        continue;
      }
      if (child.querySelector('article, main')) {
        continue;
      }
      const matched = matchRestrictionInText(getCleanElementText(child));
      if (matched) {
        return matched;
      }
    }
  }

  return null;
}
