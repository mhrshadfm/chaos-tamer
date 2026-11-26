import type {
  AccountIntent,
  AccountMode,
  AccountRecord,
  AccountStatus,
  AutomationConfig,
  ModeLimitConfig,
  SafetySettings,
  StorageStateV1,
  ThemeMode,
} from '../types/schema';
import {
  buildProfileUrl,
  createDefaultState,
  DEFAULT_AUTOMATION_CONFIG,
  DEFAULT_RUNNER_STATE,
  DEFAULT_SAFETY_SETTINGS,
  DEFAULT_SCRAPER_STATE,
  EXTENSION_AUTHOR,
  EXTENSION_NAME,
  normalizeUsername,
  setOwnRecord,
} from './constants';
import { pruneRollingTimestamps } from './rateLimiter';

const VALID_STATUSES = new Set<AccountStatus>([
  'following',
  'queued_unfollow',
  'unfollowed_migrate',
  'unfollowed_dropped',
  'migrated_following',
  'migrated_requested',
]);

const VALID_INTENTS = new Set<AccountIntent>(['migrate', 'drop']);
const VALID_MODES = new Set<AccountMode>(['old_prune', 'new_warmup']);
const VALID_THEMES = new Set<ThemeMode>(['dark', 'light']);
const USERNAME_PATTERN = /^[a-z0-9._]{1,30}$/;

export interface BackupEnvelopeV1 {
  app: string;
  author: string;
  version: string;
  schemaVersion: 1;
  exportedAt: string;
  accountCount: number;
  state: StorageStateV1;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const CSV_FORMULA_TRIGGER = /^[=+\-@\t\r]/;

function escapeCsvCell(raw: string): string {
  // Neutralize spreadsheet formula injection (CWE-1236): display names such as "=HYPERLINK(...)"
  // would otherwise execute when the exported CSV is opened in Excel / Google Sheets.
  const safe = CSV_FORMULA_TRIGGER.test(raw) ? `'${raw}` : raw;
  if (safe.includes('"') || safe.includes(',') || safe.includes('\r') || safe.includes('\n')) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

function formatOptionalTimestampCsv(ts: number | undefined): string {
  if (typeof ts === 'number' && Number.isFinite(ts) && ts > 0) {
    return new Date(ts).toISOString();
  }
  return '';
}

/**
 * Serializes full extension state as pretty-printed JSON with Chaos Tamer metadata wrapper.
 */
export function serializeStateJson(state: StorageStateV1): string {
  const envelope: BackupEnvelopeV1 = {
    app: EXTENSION_NAME,
    author: EXTENSION_AUTHOR,
    version: '1.1.0',
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    accountCount: Object.keys(state.accounts).length,
    state,
  };
  return JSON.stringify(envelope, null, 2);
}

/**
 * Serializes AccountRecord array into RFC 4180 CSV with exact column order:
 * username,displayName,profileUrl,status,intent,unfollowedAt,migratedAt
 */
export function serializeAccountsCsv(accounts: AccountRecord[]): string {
  const header = 'username,displayName,profileUrl,status,intent,unfollowedAt,migratedAt';
  const rows = accounts.map((acc) => {
    const cells = [
      acc.username,
      acc.displayName,
      acc.profileUrl,
      acc.status,
      acc.intent,
      formatOptionalTimestampCsv(acc.unfollowedAt),
      formatOptionalTimestampCsv(acc.migratedAt),
    ];
    return cells.map(escapeCsvCell).join(',');
  });

  // UTF-8 BOM: without it Excel on Windows decodes the file as ANSI and Persian/Arabic display
  // names come out garbled.
  return `\uFEFF${[header, ...rows].join('\r\n')}`;
}

function validateModeLimit(
  raw: unknown,
  fallback: ModeLimitConfig,
  label: string,
): { ok: true; value: ModeLimitConfig } | { ok: false; error: string } {
  if (raw === undefined) {
    return { ok: true, value: { ...fallback } };
  }
  if (!isPlainObject(raw)) {
    return { ok: false, error: `Invalid ${label} limits object.` };
  }
  const maxPerHour = raw.maxPerHour === undefined ? fallback.maxPerHour : raw.maxPerHour;
  const maxPerDay = raw.maxPerDay === undefined ? fallback.maxPerDay : raw.maxPerDay;

  if (
    typeof maxPerHour !== 'number' ||
    !Number.isFinite(maxPerHour) ||
    maxPerHour < 1 ||
    typeof maxPerDay !== 'number' ||
    !Number.isFinite(maxPerDay) ||
    maxPerDay < 1
  ) {
    return {
      ok: false,
      error: `${label} limits must have positive numbers for maxPerHour and maxPerDay.`,
    };
  }

  return {
    ok: true,
    value: {
      maxPerHour: Math.round(maxPerHour),
      maxPerDay: Math.round(maxPerDay),
    },
  };
}

function validateTimestampsArray(
  raw: unknown,
  label: string,
): { ok: true; value: number[] } | { ok: false; error: string } {
  if (raw === undefined) {
    return { ok: true, value: [] };
  }
  if (!Array.isArray(raw)) {
    return { ok: false, error: `${label} must be an array of timestamps.` };
  }
  for (const item of raw) {
    if (typeof item !== 'number' || !Number.isFinite(item) || item < 0) {
      return { ok: false, error: `${label} contains an invalid timestamp.` };
    }
  }
  return { ok: true, value: pruneRollingTimestamps(raw as number[]) };
}

function validateSafety(
  raw: unknown,
): { ok: true; value: SafetySettings } | { ok: false; error: string } {
  if (raw === undefined) {
    return { ok: true, value: createDefaultState().safety };
  }
  if (!isPlainObject(raw)) {
    return { ok: false, error: 'Invalid "safety" configuration in backup.' };
  }

  const accountModeRaw = raw.accountMode ?? DEFAULT_SAFETY_SETTINGS.accountMode;
  if (typeof accountModeRaw !== 'string' || !VALID_MODES.has(accountModeRaw as AccountMode)) {
    return { ok: false, error: 'Invalid safety.accountMode (expected old_prune or new_warmup).' };
  }

  const unfollowRes = validateTimestampsArray(
    raw.unfollowTimestamps,
    'safety.unfollowTimestamps',
  );
  if (!unfollowRes.ok) {
    return unfollowRes;
  }

  const followRes = validateTimestampsArray(raw.followTimestamps, 'safety.followTimestamps');
  if (!followRes.ok) {
    return followRes;
  }

  const rawLimits = raw.limits;
  if (rawLimits !== undefined && !isPlainObject(rawLimits)) {
    return { ok: false, error: 'Invalid safety.limits object.' };
  }

  const oldPruneRes = validateModeLimit(
    isPlainObject(rawLimits) ? rawLimits.old_prune : undefined,
    DEFAULT_SAFETY_SETTINGS.limits.old_prune,
    'safety.limits.old_prune',
  );
  if (!oldPruneRes.ok) {
    return oldPruneRes;
  }

  const newWarmupRes = validateModeLimit(
    isPlainObject(rawLimits) ? rawLimits.new_warmup : undefined,
    DEFAULT_SAFETY_SETTINGS.limits.new_warmup,
    'safety.limits.new_warmup',
  );
  if (!newWarmupRes.ok) {
    return newWarmupRes;
  }

  const rawAuto = raw.automationConfig;
  let automationConfig: AutomationConfig = { ...DEFAULT_AUTOMATION_CONFIG };
  if (rawAuto !== undefined) {
    if (!isPlainObject(rawAuto)) {
      return { ok: false, error: 'Invalid safety.automationConfig object.' };
    }
    const minDelaySec =
      typeof rawAuto.minDelaySec === 'number' && Number.isFinite(rawAuto.minDelaySec)
        ? Math.max(1, Math.round(rawAuto.minDelaySec))
        : DEFAULT_AUTOMATION_CONFIG.minDelaySec;
    const maxDelaySec =
      typeof rawAuto.maxDelaySec === 'number' && Number.isFinite(rawAuto.maxDelaySec)
        ? Math.max(minDelaySec, Math.round(rawAuto.maxDelaySec))
        : Math.max(minDelaySec, DEFAULT_AUTOMATION_CONFIG.maxDelaySec);
    const batchSizeBeforeBreak =
      typeof rawAuto.batchSizeBeforeBreak === 'number' &&
      Number.isFinite(rawAuto.batchSizeBeforeBreak)
        ? Math.max(1, Math.round(rawAuto.batchSizeBeforeBreak))
        : DEFAULT_AUTOMATION_CONFIG.batchSizeBeforeBreak;
    const breakMinMinutes =
      typeof rawAuto.breakMinMinutes === 'number' && Number.isFinite(rawAuto.breakMinMinutes)
        ? Math.max(1, Math.round(rawAuto.breakMinMinutes))
        : DEFAULT_AUTOMATION_CONFIG.breakMinMinutes;
    const breakMaxMinutes =
      typeof rawAuto.breakMaxMinutes === 'number' && Number.isFinite(rawAuto.breakMaxMinutes)
        ? Math.max(breakMinMinutes, Math.round(rawAuto.breakMaxMinutes))
        : Math.max(breakMinMinutes, DEFAULT_AUTOMATION_CONFIG.breakMaxMinutes);

    automationConfig = {
      minDelaySec,
      maxDelaySec,
      batchSizeBeforeBreak,
      breakMinMinutes,
      breakMaxMinutes,
      profileFallback:
        typeof rawAuto.profileFallback === 'boolean'
          ? rawAuto.profileFallback
          : DEFAULT_AUTOMATION_CONFIG.profileFallback,
      autoResumeAfterCooldown:
        typeof rawAuto.autoResumeAfterCooldown === 'boolean'
          ? rawAuto.autoResumeAfterCooldown
          : DEFAULT_AUTOMATION_CONFIG.autoResumeAfterCooldown,
    };
  }

  const safety: SafetySettings = {
    accountMode: accountModeRaw as AccountMode,
    unfollowTimestamps: unfollowRes.value,
    followTimestamps: followRes.value,
    limits: {
      old_prune: oldPruneRes.value,
      new_warmup: newWarmupRes.value,
    },
    automationConfig,
  };

  if (typeof raw.emergencyStopReason === 'string' && raw.emergencyStopReason.trim().length > 0) {
    safety.emergencyStopReason = raw.emergencyStopReason.trim();
  }

  return { ok: true, value: safety };
}

/**
 * Validates and normalizes either a raw StorageStateV1 object, a { state: StorageStateV1 } backup
 * envelope, or a JSON string representation of either.
 */
export function validateAndNormalizeBackup(
  raw: unknown,
): { valid: true; state: StorageStateV1 } | { valid: false; error: string } {
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) {
      return { valid: false, error: 'Backup input is empty.' };
    }
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      return { valid: false, error: 'Invalid JSON syntax in backup payload.' };
    }
  }

  if (!isPlainObject(parsed)) {
    return { valid: false, error: 'Backup root must be a JSON object.' };
  }

  const candidate: Record<string, unknown> =
    isPlainObject(parsed.state) && !isPlainObject(parsed.accounts) ? parsed.state : parsed;

  if (candidate.schemaVersion !== undefined && candidate.schemaVersion !== 1) {
    return {
      valid: false,
      error: `Unsupported schemaVersion "${String(candidate.schemaVersion)}" (expected 1).`,
    };
  }

  if (!isPlainObject(candidate.accounts)) {
    return { valid: false, error: 'Backup is missing a valid "accounts" object.' };
  }

  const now = Date.now();
  const normalizedAccounts: Record<string, AccountRecord> = {};

  for (const [key, rawRecord] of Object.entries(candidate.accounts)) {
    if (!isPlainObject(rawRecord)) {
      return { valid: false, error: `Account entry "${key}" must be an object.` };
    }

    const rawUsername = typeof rawRecord.username === 'string' ? rawRecord.username : key;
    const username = normalizeUsername(rawUsername);
    if (!username || !USERNAME_PATTERN.test(username)) {
      return {
        valid: false,
        error: `Account entry "${key}" has an invalid Instagram username.`,
      };
    }

    if (
      typeof rawRecord.status !== 'string' ||
      !VALID_STATUSES.has(rawRecord.status as AccountStatus)
    ) {
      return {
        valid: false,
        error: `Account "@${username}" has an invalid status "${String(rawRecord.status)}".`,
      };
    }

    const rawIntent = rawRecord.intent ?? 'migrate';
    if (typeof rawIntent !== 'string' || !VALID_INTENTS.has(rawIntent as AccountIntent)) {
      return {
        valid: false,
        error: `Account "@${username}" has an invalid intent "${String(rawIntent)}".`,
      };
    }

    if (rawRecord.displayName !== undefined && typeof rawRecord.displayName !== 'string') {
      return { valid: false, error: `Account "@${username}" has a non-string displayName.` };
    }

    const extractedAt =
      typeof rawRecord.extractedAt === 'number' &&
      Number.isFinite(rawRecord.extractedAt) &&
      rawRecord.extractedAt > 0
        ? rawRecord.extractedAt
        : now;

    if (
      rawRecord.extractedAt !== undefined &&
      (typeof rawRecord.extractedAt !== 'number' ||
        !Number.isFinite(rawRecord.extractedAt) ||
        rawRecord.extractedAt < 0)
    ) {
      return { valid: false, error: `Account "@${username}" has an invalid extractedAt value.` };
    }

    let unfollowedAt: number | undefined;
    if (rawRecord.unfollowedAt !== undefined && rawRecord.unfollowedAt !== null) {
      if (
        typeof rawRecord.unfollowedAt !== 'number' ||
        !Number.isFinite(rawRecord.unfollowedAt) ||
        rawRecord.unfollowedAt < 0
      ) {
        return {
          valid: false,
          error: `Account "@${username}" has an invalid unfollowedAt timestamp.`,
        };
      }
      unfollowedAt = rawRecord.unfollowedAt;
    }

    let migratedAt: number | undefined;
    if (rawRecord.migratedAt !== undefined && rawRecord.migratedAt !== null) {
      if (
        typeof rawRecord.migratedAt !== 'number' ||
        !Number.isFinite(rawRecord.migratedAt) ||
        rawRecord.migratedAt < 0
      ) {
        return {
          valid: false,
          error: `Account "@${username}" has an invalid migratedAt timestamp.`,
        };
      }
      migratedAt = rawRecord.migratedAt;
    }

    const record: AccountRecord = {
      username,
      displayName:
        typeof rawRecord.displayName === 'string' && rawRecord.displayName.trim().length > 0
          ? rawRecord.displayName.trim()
          : username,
      avatarUrl: typeof rawRecord.avatarUrl === 'string' ? rawRecord.avatarUrl : '',
      // Always rebuild from the validated username: an imported backup must never be able to
      // point "Open profile" / profile-fallback navigation at a non-Instagram URL.
      profileUrl: buildProfileUrl(username),
      isVerified: Boolean(rawRecord.isVerified),
      status: rawRecord.status as AccountStatus,
      intent: rawIntent as AccountIntent,
      extractedAt,
      ...(unfollowedAt !== undefined ? { unfollowedAt } : {}),
      ...(migratedAt !== undefined ? { migratedAt } : {}),
    };

    setOwnRecord(normalizedAccounts, username, record);
  }

  const safetyRes = validateSafety(candidate.safety);
  if (!safetyRes.ok) {
    return { valid: false, error: safetyRes.error };
  }

  const rawTheme = candidate.theme ?? 'dark';
  if (typeof rawTheme !== 'string' || !VALID_THEMES.has(rawTheme as ThemeMode)) {
    return { valid: false, error: 'Invalid theme in backup (expected "dark" or "light").' };
  }

  const includeFollowingInMigrate =
    typeof candidate.includeFollowingInMigrate === 'boolean'
      ? candidate.includeFollowingInMigrate
      : false;

  const activeVisitedUsername =
    typeof candidate.activeVisitedUsername === 'string' &&
    candidate.activeVisitedUsername.trim().length > 0
      ? normalizeUsername(candidate.activeVisitedUsername)
      : undefined;

  const state: StorageStateV1 = {
    schemaVersion: 1,
    theme: rawTheme as ThemeMode,
    ...(activeVisitedUsername ? { activeVisitedUsername } : {}),
    includeFollowingInMigrate,
    accounts: normalizedAccounts,
    safety: safetyRes.value,
    scraper: {
      ...DEFAULT_SCRAPER_STATE,
      extractedCount: Object.keys(normalizedAccounts).length,
    },
    runner: safetyRes.value.emergencyStopReason
      ? {
          ...DEFAULT_RUNNER_STATE,
          state: 'circuit_tripped',
          statusText: safetyRes.value.emergencyStopReason,
        }
      : { ...DEFAULT_RUNNER_STATE },
  };

  return { valid: true, state };
}

/**
 * Checks whether native Android file sharing (`Intent.ACTION_SEND`) is available.
 */
export function canShareExportNatively(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.ChaosTamerAndroidPanel?.shareExportFile === 'function'
  );
}

/**
 * Invokes the native Android share sheet (`Quick Share`, `Telegram`, `Drive`, etc.) for an export file.
 */
export function triggerNativeShareExport(
  filename: string,
  content: string,
  mimeType: string,
): boolean {
  if (
    typeof window !== 'undefined' &&
    typeof window.ChaosTamerAndroidPanel?.shareExportFile === 'function'
  ) {
    try {
      return window.ChaosTamerAndroidPanel.shareExportFile(filename, content, mimeType);
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Triggers a client-side file download cleanly in Chrome Side Panel, Native Android SAF, and browser preview.
 */
export function triggerFileDownload(filename: string, content: string, mimeType: string): void {
  if (
    typeof window !== 'undefined' &&
    typeof window.ChaosTamerAndroidPanel?.saveExportFile === 'function'
  ) {
    try {
      if (window.ChaosTamerAndroidPanel.saveExportFile(filename, content, mimeType)) {
        return;
      }
    } catch {
      // Fall through to standard anchor download if native bridge declines
    }
  }

  if (typeof document === 'undefined') {
    return;
  }
  const blob = new Blob([content], { type: mimeType });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);

  setTimeout(() => {
    URL.revokeObjectURL(objectUrl);
  }, 1500);
}
