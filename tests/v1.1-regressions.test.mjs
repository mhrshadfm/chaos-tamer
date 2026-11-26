import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');

async function importTsModule(relativePath) {
  const result = await build({
    entryPoints: [resolve(rootDir, relativePath)],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
  });
  const code = `${result.outputFiles[0].text}\n// ${Math.random()}`;
  return import(`data:text/javascript;base64,${Buffer.from(code, 'utf8').toString('base64')}`);
}

/** In-memory chrome.storage.local stand-in for exercising src/background/store.ts. */
function installChromeStorageMock() {
  const data = {};
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) {
          const k = Array.isArray(key) ? key[0] : key;
          return k in data ? { [k]: structuredClone(data[k]) } : {};
        },
        async set(items) {
          for (const [k, v] of Object.entries(items)) data[k] = structuredClone(v);
        },
      },
    },
  };
  return data;
}

const HOUR = 3_600_000;
const DAY = 86_400_000;

test('rateLimiter: cooldown uses the (count-max)th oldest timestamp when usage overshoots the cap', async () => {
  const { evaluateRateLimit, pruneRollingTimestamps } = await importTsModule('src/lib/rateLimiter.ts');
  const now = 10 * DAY;
  // 14 unfollows in the last hour, spread 4 minutes apart, cap lowered to 10/hour.
  const ts = Array.from({ length: 14 }, (_, i) => now - 56 * 60_000 + i * 4 * 60_000);
  const safety = {
    accountMode: 'old_prune',
    unfollowTimestamps: ts,
    followTimestamps: [],
    limits: { old_prune: { maxPerHour: 10, maxPerDay: 80 }, new_warmup: { maxPerHour: 10, maxPerDay: 35 } },
    automationConfig: {},
  };
  const snap = evaluateRateLimit(safety, 'old_prune', now);
  assert.equal(snap.canAct, false);
  // Need 14 - 10 + 1 = 5 timestamps to expire → the 5th oldest (index 4) releases the slot.
  assert.equal(snap.nextSlotAvailableInMs, ts[4] + HOUR - now);

  // Exactly at the cap keeps the original behaviour (oldest timestamp).
  const atCap = evaluateRateLimit({ ...safety, unfollowTimestamps: ts.slice(4) }, 'old_prune', now);
  assert.equal(atCap.nextSlotAvailableInMs, ts[4] + HOUR - now);

  // Future timestamps (clock moved back) are clamped to now, not dropped or kept forever.
  const pruned = pruneRollingTimestamps([now - 2 * DAY, now - 1000, now + 5 * 60_000], now);
  assert.deepEqual(pruned, [now - 1000, now]);
});

test('exporters: CSV neutralizes formulas and has a UTF-8 BOM; backups cannot carry foreign profile URLs', async () => {
  const { serializeAccountsCsv, validateAndNormalizeBackup } = await importTsModule('src/lib/exporters.ts');
  const csv = serializeAccountsCsv([
    {
      username: 'evil',
      displayName: '=HYPERLINK("http://x","click")',
      profileUrl: 'https://www.instagram.com/evil/',
      status: 'following',
      intent: 'migrate',
      extractedAt: 1,
    },
  ]);
  assert.ok(csv.startsWith('﻿username,'), 'CSV must start with a BOM for Excel');
  assert.ok(csv.includes(`"'=HYPERLINK(""http://x"",""click"")"`), csv);

  const res = validateAndNormalizeBackup({
    schemaVersion: 1,
    accounts: {
      victim: { username: 'victim', status: 'following', profileUrl: 'https://phishing.example/login' },
      constructor: { username: 'constructor', status: 'following' },
      __proto__: { username: '__proto__', status: 'following' },
    },
  });
  assert.equal(res.valid, true);
  assert.equal(res.state.accounts.victim.profileUrl, 'https://www.instagram.com/victim/');
  assert.equal(Object.prototype.hasOwnProperty.call(res.state.accounts, 'constructor'), true);
  assert.equal(res.state.accounts.constructor.username, 'constructor');
});

test('store: Replace import keeps rolling history + emergency lock; merge ties keep local decisions', async () => {
  const data = installChromeStorageMock();
  const store = await importTsModule('src/background/store.ts');
  const now = Date.now();

  await store.upsertAccountsBatch([
    { username: 'alpha', displayName: 'Alpha', avatarUrl: '', isVerified: false },
    { username: 'beta', displayName: 'Beta', avatarUrl: '', isVerified: false },
  ]);
  await store.setIntentBulk(['alpha'], 'drop');
  // 3 real unfollows today on this device
  for (const name of ['x1', 'x2', 'x3']) {
    await store.recordUnfollowEvent(name);
  }
  await store.tripCircuitBreaker('Instagram restriction detected ("try again later")');

  // Merge: backup says alpha=migrate (same rank as local "following") → local "drop" wins.
  const merged = await store.importBackupData(
    { schemaVersion: 1, accounts: { alpha: { username: 'alpha', status: 'following', intent: 'migrate' } } },
    'merge',
  );
  assert.equal(merged.ok, true);
  assert.equal(merged.state.accounts.alpha.intent, 'drop');

  // Replace with an older backup that has no history and no lock.
  const replaced = await store.importBackupData(
    { schemaVersion: 1, accounts: { gamma: { username: 'gamma', status: 'following' } } },
    'replace',
  );
  assert.equal(replaced.ok, true);
  assert.deepEqual(Object.keys(replaced.state.accounts), ['gamma']);
  assert.equal(replaced.state.safety.unfollowTimestamps.length, 3, 'today\'s unfollows must survive Replace');
  assert.ok(replaced.state.safety.emergencyStopReason, 'emergency lock must survive Replace');
  assert.equal(replaced.state.runner.state, 'circuit_tripped');

  // While latched, a late "stopped" patch from a content engine cannot hide the trip.
  const afterPatch = await store.patchRunnerState({ state: 'idle', statusText: 'Safe auto-unfollow stopped.' });
  assert.equal(afterPatch.runner.state, 'circuit_tripped');
  await store.clearCircuitBreaker();
  const cleared = await store.patchRunnerState({ state: 'idle' });
  assert.equal(cleared.runner.state, 'idle');

  // Undoing "Done" in the Migrate tab gives the warm-up slot back.
  await store.setAccountStatus('gamma', 'migrated_following', true);
  let state = await store.readState();
  assert.equal(state.safety.followTimestamps.length, 1);
  await store.setAccountStatus('gamma', 'unfollowed_migrate', false);
  state = await store.readState();
  assert.equal(state.safety.followTimestamps.length, 0);

  // Import is refused while the runner is active.
  await store.patchRunnerState({ state: 'running' });
  const busy = await store.importBackupData({ schemaVersion: 1, accounts: {} }, 'merge');
  assert.equal(busy.ok, false);
  assert.match(busy.error, /Stop the running/);

  // Usernames that collide with Object.prototype are stored as real accounts.
  await store.patchRunnerState({ state: 'idle' });
  const proto = await store.upsertAccountsBatch([
    { username: 'constructor', displayName: 'C', avatarUrl: '', isVerified: false },
  ]);
  assert.equal(Object.prototype.hasOwnProperty.call(proto.accounts, 'constructor'), true);
  assert.equal(proto.accounts.constructor.displayName, 'C');
  assert.ok(now > 0 && data);
});

test('constants: normalizeSearchText unifies Persian/Arabic variants', async () => {
  const { normalizeSearchText } = await importTsModule('src/lib/constants.ts');
  // Arabic Yeh/Kaf + ZWNJ vs Persian forms
  assert.equal(normalizeSearchText('علي‌كريمي'), normalizeSearchText('علیکریمی'));
  assert.equal(normalizeSearchText('  @Some.User '), '@some.user');
});
