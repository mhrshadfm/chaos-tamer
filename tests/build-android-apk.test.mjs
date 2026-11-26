import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  copyAndVerifyReleaseApks,
  DEFAULT_KEY_ALIAS,
  DEFAULT_KEYSTORE_PASSWORD,
  ensureReleaseKeystore,
  resolveKeystoreConfig,
  resolveKeytoolBin,
  resolveReleaseApkTargets,
  verifyApkArchive,
} from '../scripts/build-android-apk.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'chaos-tamer-apk-test-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

test('.gitignore: ignores release keystores and build outputs while keeping wrapper & source files tracked', () => {
  withTempDir((tmp) => {
    copyFileSync(resolve(rootDir, '.gitignore'), join(tmp, '.gitignore'));
    const initRes = spawnSync('git', ['init', '-q'], { cwd: tmp, encoding: 'utf8' });
    assert.equal(initRes.status, 0, `git init failed: ${initRes.stderr}`);

    const mustIgnore = [
      'android/app/keystore/chaos-tamer-release.jks',
      'android/app/keystore/upload.keystore',
      'my-private-signing-key.jks',
      'signing.keystore',
      'release/chaos-tamer.zip',
      'release/chaos-tamer-v1.0.0.zip',
      'release/chaos-tamer-android.apk',
      'release/chaos-tamer-android-v1.0.0.apk',
      'android/local.properties',
      'android/app/src/main/assets/panel/sidepanel.html',
    ];
    for (const relPath of mustIgnore) {
      const res = spawnSync('git', ['check-ignore', '-q', relPath], { cwd: tmp });
      assert.equal(res.status, 0, `Expected .gitignore to ignore ${relPath}`);
    }

    const mustTrack = [
      'release/GITHUB_RELEASE_NOTES.md',
      'android/gradle/wrapper/gradle-wrapper.jar',
      'android/gradlew',
      'android/gradlew.bat',
      'android/app/build.gradle.kts',
      'scripts/build-android-apk.mjs',
      'README.md',
      '.github/workflows/ci.yml',
    ];
    for (const relPath of mustTrack) {
      const res = spawnSync('git', ['check-ignore', '-q', relPath], { cwd: tmp });
      assert.equal(res.status, 1, `Expected .gitignore NOT to ignore ${relPath}`);
    }
  });
});

test('resolveKeystoreConfig: handles empty/blank env vars, repo-root android/... paths, and storePassword fallback', () => {
  withTempDir((tmp) => {
    const fakeRoot = join(tmp, 'repo');
    const fakeApp = join(fakeRoot, 'android', 'app');

    // Empty and whitespace-only env vars (such as unset GitHub Actions secrets or CRLF blanks) fall back cleanly
    const fallbackCfg = resolveKeystoreConfig(
      {
        CHAOS_TAMER_KEYSTORE_PATH: '   ',
        CHAOS_TAMER_KEYSTORE_PASSWORD: '   ',
        CHAOS_TAMER_KEY_ALIAS: '  ',
        CHAOS_TAMER_KEY_PASSWORD: '\r\n',
      },
      { rootDirPath: fakeRoot, androidAppDirPath: fakeApp },
    );
    assert.equal(
      fallbackCfg.keystoreFile,
      resolve(fakeApp, 'keystore/chaos-tamer-release.jks'),
    );
    assert.equal(fallbackCfg.storePassword, DEFAULT_KEYSTORE_PASSWORD);
    assert.equal(fallbackCfg.keyAlias, DEFAULT_KEY_ALIAS);
    assert.equal(fallbackCfg.keyPassword, DEFAULT_KEYSTORE_PASSWORD);

    // Non-existent repo-root-relative path starting with android/ MUST NOT double android/app/android/app
    const nonExistentRepoRel = resolveKeystoreConfig(
      { CHAOS_TAMER_KEYSTORE_PATH: 'android/app/keystore/ci-custom.jks' },
      { rootDirPath: fakeRoot, androidAppDirPath: fakeApp },
    );
    assert.equal(
      nonExistentRepoRel.keystoreFile,
      resolve(fakeRoot, 'android/app/keystore/ci-custom.jks'),
    );

    const dotSlashRepoRel = resolveKeystoreConfig(
      { CHAOS_TAMER_KEYSTORE_PATH: './android/app/keystore/ci-custom.jks' },
      { rootDirPath: fakeRoot, androidAppDirPath: fakeApp },
    );
    assert.equal(
      dotSlashRepoRel.keystoreFile,
      resolve(fakeRoot, 'android/app/keystore/ci-custom.jks'),
    );

    // Custom storePassword cascades to keyPassword when CHAOS_TAMER_KEY_PASSWORD is unset/blank
    const customStoreOnly = resolveKeystoreConfig(
      {
        CHAOS_TAMER_KEYSTORE_PATH: 'keystore/custom.jks',
        CHAOS_TAMER_KEYSTORE_PASSWORD: 'custom-store-secret-123',
        CHAOS_TAMER_KEY_PASSWORD: '   ',
      },
      { rootDirPath: fakeRoot, androidAppDirPath: fakeApp },
    );
    assert.equal(customStoreOnly.keystoreFile, resolve(fakeApp, 'keystore/custom.jks'));
    assert.equal(customStoreOnly.storePassword, 'custom-store-secret-123');
    assert.equal(customStoreOnly.keyPassword, 'custom-store-secret-123');

    // Existing file relative to repo root is preferred if absent under android/app
    const rootKeystore = join(fakeRoot, 'existing-root.jks');
    rmSync(fakeRoot, { recursive: true, force: true });
    writeFileSync(
      (() => {
        const p = rootKeystore;
        spawnSync(process.execPath, ['-e', `require('fs').mkdirSync(${JSON.stringify(fakeRoot)}, {recursive:true})`]);
        return p;
      })(),
      Buffer.from('placeholder'),
    );
    const rootRelCfg = resolveKeystoreConfig(
      { CHAOS_TAMER_KEYSTORE_PATH: 'existing-root.jks' },
      { rootDirPath: fakeRoot, androidAppDirPath: fakeApp },
    );
    assert.equal(rootRelCfg.keystoreFile, rootKeystore);
  });
});

test('ensureReleaseKeystore: auto-generates via keytool when absent, preserves existing .jks, heals 0-byte remnants, and redacts secrets on failure', () => {
  withTempDir((tmp) => {
    const keystoreFile = join(tmp, 'nested', 'keystore', 'chaos-tamer-release.jks');
    const config = {
      keystoreFile,
      storePassword: DEFAULT_KEYSTORE_PASSWORD,
      keyAlias: DEFAULT_KEY_ALIAS,
      keyPassword: DEFAULT_KEYSTORE_PASSWORD,
    };

    // 1. Fresh generation when absent
    const first = ensureReleaseKeystore(config);
    assert.equal(first.generated, true);
    assert.equal(existsSync(keystoreFile), true);
    const firstHash = sha256File(keystoreFile);

    // Verify generated keystore with real keytool -list
    const keytoolBin = resolveKeytoolBin();
    const listRes = spawnSync(
      keytoolBin,
      [
        '-list',
        '-keystore',
        keystoreFile,
        '-storepass',
        DEFAULT_KEYSTORE_PASSWORD,
        '-alias',
        DEFAULT_KEY_ALIAS,
      ],
      { encoding: 'utf8', shell: false },
    );
    assert.equal(listRes.status, 0, `keytool -list failed: ${listRes.stderr}`);
    assert.match(listRes.stdout, /PrivateKeyEntry/);

    // 2. Subsequent call preserves existing keystore byte-for-byte
    const second = ensureReleaseKeystore(config);
    assert.equal(second.generated, false);
    assert.equal(sha256File(keystoreFile), firstHash, 'Existing .jks must be preserved untouched');

    // 3. Truncated 0-byte remnant is healed by regenerating
    const truncatedFile = join(tmp, 'truncated.jks');
    writeFileSync(truncatedFile, Buffer.alloc(0));
    const healed = ensureReleaseKeystore({ ...config, keystoreFile: truncatedFile });
    assert.equal(healed.generated, true);
    assert.ok(readFileSync(truncatedFile).length > 1000);

    // 4. Distinct storePassword and keyPassword works cleanly via JKS storetype
    const distinctFile = join(tmp, 'distinct-passwords.jks');
    const distinctRes = ensureReleaseKeystore({
      keystoreFile: distinctFile,
      storePassword: 'store-password-alpha',
      keyAlias: 'distinctalias',
      keyPassword: 'key-password-bravo',
    });
    assert.equal(distinctRes.generated, true);
    const distinctCheck = spawnSync(
      keytoolBin,
      [
        '-list',
        '-keystore',
        distinctFile,
        '-storepass',
        'store-password-alpha',
        '-alias',
        'distinctalias',
      ],
      { encoding: 'utf8', shell: false },
    );
    assert.equal(distinctCheck.status, 0);

    // 5. Failure redacts passwords from error message and leaves no partial file
    const badFile = join(tmp, 'bad-pass.jks');
    const badSecret = ' tiny'; // < 6 chars triggers keytool validation failure
    assert.throws(
      () =>
        ensureReleaseKeystore({
          keystoreFile: badFile,
          storePassword: badSecret,
          keyAlias: 'chaostamer',
          keyPassword: badSecret,
        }),
      (err) => {
        assert.equal(
          err.message.includes(badSecret),
          false,
          'Thrown error must not leak keystore password',
        );
        return true;
      },
    );
    assert.equal(existsSync(badFile), false, 'Failed keytool run must not leave partial .jks');

    // 6. Missing keytool binary throws descriptive error without leaking secrets
    assert.throws(
      () =>
        ensureReleaseKeystore(
          {
            keystoreFile: join(tmp, 'missing-bin.jks'),
            storePassword: 'super-secret-passphrase',
            keyAlias: 'chaostamer',
            keyPassword: 'super-secret-passphrase',
          },
          { keytoolBinOverride: join(tmp, 'definitely-missing-keytool-binary') },
        ),
      (err) => {
        assert.match(err.message, /Failed to execute keytool/);
        assert.equal(err.message.includes('super-secret-passphrase'), false);
        return true;
      },
    );

    // 7. CHAOS_TAMER_KEYSTORE_BASE64 restores byte-identical keystore when absent (including wrapped lines)
    //    and never overwrites an existing non-empty local keystore
    const rawKeystoreBytes = readFileSync(keystoreFile);
    const wrappedBase64 = rawKeystoreBytes
      .toString('base64')
      .replace(/(.{76})/g, '$1\r\n');
    const restoredPath = join(tmp, 'from-base64', 'chaos-tamer-release.jks');
    const restoredRes = ensureReleaseKeystore(
      { ...config, keystoreFile: restoredPath },
      { env: { ...process.env, CHAOS_TAMER_KEYSTORE_BASE64: wrappedBase64 } },
    );
    assert.equal(restoredRes.generated, false);
    assert.equal(restoredRes.restoredFromBase64, true);
    assert.equal(sha256File(restoredPath), firstHash);

    // Existing file takes priority even when CHAOS_TAMER_KEYSTORE_BASE64 is set to something else
    const preserveOverB64 = ensureReleaseKeystore(
      { ...config, keystoreFile: distinctFile },
      { env: { ...process.env, CHAOS_TAMER_KEYSTORE_BASE64: wrappedBase64 } },
    );
    assert.equal(preserveOverB64.restoredFromBase64, false);
    assert.notEqual(sha256File(distinctFile), firstHash);

    // Malformed / non-keystore base64 fails cleanly without leaking secret or writing corrupt file
    const badB64Target = join(tmp, 'bad-b64.jks');
    const nonKeystoreB64 = Buffer.from('plain text that is definitely not a keystore archive!').toString('base64');
    assert.throws(
      () =>
        ensureReleaseKeystore(
          { ...config, keystoreFile: badB64Target },
          { env: { CHAOS_TAMER_KEYSTORE_BASE64: nonKeystoreB64 } },
        ),
      (err) => {
        assert.equal(err.message.includes(nonKeystoreB64), false);
        return true;
      },
    );
    assert.equal(existsSync(badB64Target), false);
  });
});

test('CI workflow & release notes: aligns setup-android, body_path, and versioned ZIP/APK release assets', () => {
  const ciYaml = readFileSync(resolve(rootDir, '.github/workflows/ci.yml'), 'utf8');
  const releaseNotes = readFileSync(resolve(rootDir, 'release/GITHUB_RELEASE_NOTES.md'), 'utf8');
  const pkgVersion = JSON.parse(readFileSync(resolve(rootDir, 'package.json'), 'utf8')).version;
  const versionedName = (prefix, ext) =>
    new RegExp(`${prefix}-v${pkgVersion.replace(/\./g, '\\.')}\\.${ext}`);

  assert.match(ciYaml, /android-actions\/setup-android@v3/);
  assert.match(ciYaml, /body_path:\s*release\/GITHUB_RELEASE_NOTES\.md/);
  assert.match(ciYaml, /release\/chaos-tamer\.zip/);
  assert.match(ciYaml, /release\/chaos-tamer-v\*\.zip/);
  assert.match(ciYaml, /release\/chaos-tamer-android\.apk/);
  assert.match(ciYaml, /release\/chaos-tamer-android-v\*\.apk/);

  assert.match(releaseNotes, /chaos-tamer\.zip/);
  assert.match(releaseNotes, versionedName('chaos-tamer', 'zip'));
  assert.match(releaseNotes, /chaos-tamer-android\.apk/);
  assert.match(releaseNotes, versionedName('chaos-tamer-android', 'apk'));
  assert.match(releaseNotes, /One UI 5\.1/);
});

test('copyAndVerifyReleaseApks & verifyApkArchive: emits unversioned + v1.0.0 APK mirrors and rejects invalid/unsigned archives', () => {
  withTempDir((tmp) => {
    const outDir = join(tmp, 'release');
    const targets = resolveReleaseApkTargets(outDir, 'v1.0.0');
    assert.deepEqual(targets, [
      resolve(outDir, 'chaos-tamer-android.apk'),
      resolve(outDir, 'chaos-tamer-android-v1.0.0.apk'),
    ]);

    // Missing file fails
    assert.throws(() => verifyApkArchive(join(tmp, 'missing.apk')), /not found/);

    // Too small fails
    const tinyApk = join(tmp, 'tiny.apk');
    writeFileSync(tinyApk, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    assert.throws(() => verifyApkArchive(tinyApk), /unexpectedly small/);

    // Bad header fails
    const badHeaderApk = join(tmp, 'bad-header.apk');
    writeFileSync(badHeaderApk, Buffer.alloc(600_000, 0x41));
    assert.throws(() => verifyApkArchive(badHeaderApk), /PKZIP header/);

    // Unsigned PKZIP missing APK Sig Block 42 fails
    const unsignedApk = join(tmp, 'unsigned.apk');
    const unsignedPayload = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from(
        'AndroidManifest.xml classes.dex assets/panel/sidepanel.html assets/panel/content.js',
        'latin1',
      ),
      Buffer.alloc(600_000, 0),
    ]);
    writeFileSync(unsignedApk, unsignedPayload);
    assert.throws(() => verifyApkArchive(unsignedApk), /APK Sig Block 42/);

    // Valid synthetic signed APK structure passes and emits both mirrors identically
    const signedBuiltApk = join(tmp, 'app-release.apk');
    const signedPayload = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from(
        'AndroidManifest.xml classes.dex assets/panel/sidepanel.html assets/panel/content.js APK Sig Block 42',
        'latin1',
      ),
      Buffer.alloc(600_000, 0),
    ]);
    writeFileSync(signedBuiltApk, signedPayload);

    const { targets: writtenTargets, sizeBytes } = copyAndVerifyReleaseApks(
      signedBuiltApk,
      outDir,
      '1.0.0',
    );
    assert.equal(writtenTargets.length, 2);
    assert.equal(sizeBytes, signedPayload.length);
    assert.equal(existsSync(resolve(outDir, 'chaos-tamer-android.apk')), true);
    assert.equal(existsSync(resolve(outDir, 'chaos-tamer-android-v1.0.0.apk')), true);
    assert.equal(
      sha256File(resolve(outDir, 'chaos-tamer-android.apk')),
      sha256File(resolve(outDir, 'chaos-tamer-android-v1.0.0.apk')),
    );
  });
});
