import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = resolve(__dirname, '..');
const androidDir = resolve(rootDir, 'android');
const androidAppDir = resolve(androidDir, 'app');
const releaseDir = resolve(rootDir, 'release');
const builtApkPath = resolve(
  androidAppDir,
  'build',
  'outputs',
  'apk',
  'release',
  'app-release.apk',
);

export const DEFAULT_KEYSTORE_REL_PATH = 'keystore/chaos-tamer-release.jks';
export const DEFAULT_KEYSTORE_PASSWORD = 'chaostamer-android-release';
export const DEFAULT_KEY_ALIAS = 'chaostamer';
export const DEFAULT_KEYSTORE_DNAME = 'CN=Chaos Tamer, OU=@mhrshadfm, O=ChaosTamer, C=US';

export function resolveAndroidSdkRoot(env = process.env) {
  if (env.ANDROID_HOME && existsSync(env.ANDROID_HOME)) {
    return env.ANDROID_HOME;
  }
  if (env.ANDROID_SDK_ROOT && existsSync(env.ANDROID_SDK_ROOT)) {
    return env.ANDROID_SDK_ROOT;
  }
  const localToolchainSdk = resolve(rootDir, '.android-toolchain', 'sdk');
  if (existsSync(localToolchainSdk)) {
    return localToolchainSdk;
  }
  const winDefault = env.LOCALAPPDATA
    ? resolve(env.LOCALAPPDATA, 'Android', 'Sdk')
    : '';
  if (winDefault && existsSync(winDefault)) {
    return winDefault;
  }
  if (env.HOME) {
    const linuxDefault = resolve(env.HOME, 'Android', 'Sdk');
    if (existsSync(linuxDefault)) {
      return linuxDefault;
    }
    const macDefault = resolve(env.HOME, 'Library', 'Android', 'sdk');
    if (existsSync(macDefault)) {
      return macDefault;
    }
  }
  return '';
}

export function resolveKeystoreConfig(
  env = process.env,
  { rootDirPath = rootDir, androidAppDirPath = androidAppDir } = {},
) {
  const rawPath = (env.CHAOS_TAMER_KEYSTORE_PATH ?? '').trim();
  let keystoreFile;
  if (!rawPath) {
    keystoreFile = resolve(androidAppDirPath, DEFAULT_KEYSTORE_REL_PATH);
  } else if (isAbsolute(rawPath)) {
    keystoreFile = resolve(rawPath);
  } else {
    const appCandidate = resolve(androidAppDirPath, rawPath);
    const rootCandidate = resolve(rootDirPath, rawPath);
    const normalizedRel = rawPath.replace(/\\/g, '/').replace(/^\.\//, '');
    if (existsSync(appCandidate)) {
      keystoreFile = appCandidate;
    } else if (existsSync(rootCandidate) || normalizedRel.startsWith('android/')) {
      keystoreFile = rootCandidate;
    } else {
      keystoreFile = appCandidate;
    }
  }

  const rawStorePassword = env.CHAOS_TAMER_KEYSTORE_PASSWORD ?? '';
  const storePassword =
    rawStorePassword.trim().length > 0 ? rawStorePassword : DEFAULT_KEYSTORE_PASSWORD;
  const keyAlias = (env.CHAOS_TAMER_KEY_ALIAS ?? '').trim() || DEFAULT_KEY_ALIAS;
  const rawKeyPassword = env.CHAOS_TAMER_KEY_PASSWORD ?? '';
  const keyPassword = rawKeyPassword.trim().length > 0 ? rawKeyPassword : storePassword;

  return {
    keystoreFile,
    storePassword,
    keyAlias,
    keyPassword,
  };
}

export function resolveKeytoolBin(env = process.env, platform = process.platform) {
  const rawJavaHome = (env.JAVA_HOME ?? '').trim().replace(/^["']|["']$/g, '');
  if (rawJavaHome) {
    const candidates =
      platform === 'win32'
        ? [resolve(rawJavaHome, 'bin', 'keytool.exe'), resolve(rawJavaHome, 'bin', 'keytool')]
        : [resolve(rawJavaHome, 'bin', 'keytool')];
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return platform === 'win32' ? 'keytool.exe' : 'keytool';
}

function redactSecrets(text, secrets) {
  let out = String(text ?? '');
  for (const secret of secrets) {
    if (secret && secret.length > 0) {
      out = out.split(secret).join('[REDACTED]');
    }
  }
  return out;
}

function isValidKeystoreBinaryHeader(buf) {
  if (!buf || buf.length < 32) return false;
  // JKS magic 0xFEEDFEED or PKCS#12 DER ASN.1 SEQUENCE tag 0x30
  const isJks = buf[0] === 0xfe && buf[1] === 0xed && buf[2] === 0xfe && buf[3] === 0xed;
  const isPkcs12 = buf[0] === 0x30;
  return isJks || isPkcs12;
}

export function ensureReleaseKeystore(
  config,
  { env = process.env, platform = process.platform, keytoolBinOverride = '' } = {},
) {
  if (existsSync(config.keystoreFile)) {
    const existingSize = statSync(config.keystoreFile).size;
    if (existingSize > 0) {
      return { keystoreFile: config.keystoreFile, generated: false, restoredFromBase64: false };
    }
    rmSync(config.keystoreFile, { force: true });
  }

  mkdirSync(dirname(config.keystoreFile), { recursive: true });

  const rawBase64 = (env.CHAOS_TAMER_KEYSTORE_BASE64 ?? '').trim();
  if (rawBase64.length > 0) {
    const compact = rawBase64.replace(/\s+/g, '');
    const validAlphabet = compact.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(compact);
    if (!validAlphabet) {
      throw new Error(
        'CHAOS_TAMER_KEYSTORE_BASE64 is not valid base64. Encode your .jks file with standard base64.',
      );
    }
    const decoded = Buffer.from(compact, 'base64');
    if (!isValidKeystoreBinaryHeader(decoded)) {
      throw new Error(
        'CHAOS_TAMER_KEYSTORE_BASE64 did not decode to a valid PKCS12 or JKS keystore archive.',
      );
    }
    writeFileSync(config.keystoreFile, decoded);
    return { keystoreFile: config.keystoreFile, generated: false, restoredFromBase64: true };
  }

  const keytoolBin = keytoolBinOverride || resolveKeytoolBin(env, platform);
  const storeType = config.storePassword === config.keyPassword ? 'PKCS12' : 'JKS';
  const args = [
    '-genkeypair',
    '-storetype',
    storeType,
    '-keystore',
    config.keystoreFile,
    '-alias',
    config.keyAlias,
    '-keyalg',
    'RSA',
    '-keysize',
    '2048',
    '-validity',
    '10000',
    '-storepass',
    config.storePassword,
    '-keypass',
    config.keyPassword,
    '-dname',
    DEFAULT_KEYSTORE_DNAME,
  ];

  const result = spawnSync(keytoolBin, args, {
    cwd: rootDir,
    encoding: 'utf8',
    shell: false,
    env,
  });

  if (result.error) {
    rmSync(config.keystoreFile, { force: true });
    throw new Error(
      `Failed to execute keytool (${keytoolBin}): ${redactSecrets(result.error.message, [
        config.storePassword,
        config.keyPassword,
      ])}. Ensure JDK 17+ is installed or JAVA_HOME is set.`,
    );
  }

  if (result.status !== 0) {
    rmSync(config.keystoreFile, { force: true });
    const combinedOutput = redactSecrets(
      [result.stdout, result.stderr].filter(Boolean).join('\n').trim(),
      [config.storePassword, config.keyPassword],
    );
    throw new Error(
      `keytool failed with exit code ${result.status}${
        combinedOutput ? `: ${combinedOutput}` : ''
      }`,
    );
  }

  if (!existsSync(config.keystoreFile) || statSync(config.keystoreFile).size === 0) {
    throw new Error(`keytool exited cleanly, but keystore was not created at ${config.keystoreFile}.`);
  }

  return { keystoreFile: config.keystoreFile, generated: true, restoredFromBase64: false };
}

function runStep(command, args, cwd, extraEnv = {}) {
  const isWin = process.platform === 'win32';
  const useCmdWrapper =
    isWin && (command.endsWith('.cmd') || command.endsWith('.bat') || command === 'npm');
  const execBin = command === 'node' ? process.execPath : useCmdWrapper ? 'cmd.exe' : command;
  const execArgs = useCmdWrapper
    ? ['/d', '/s', '/c', [command === 'npm' ? 'npm.cmd' : command, ...args].join(' ')]
    : args;

  const result = spawnSync(execBin, execArgs, {
    cwd,
    stdio: 'inherit',
    shell: false,
    env: { ...process.env, ...extraEnv },
  });
  if (result.error) {
    throw new Error(`Failed to spawn ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`Command failed (${result.status}): ${command} ${args.join(' ')}`);
  }
}

export function verifyApkArchive(apkPath) {
  if (!existsSync(apkPath)) {
    throw new Error(`Expected release APK at ${apkPath}, but file was not found.`);
  }
  const sizeBytes = statSync(apkPath).size;
  if (sizeBytes < 500_000) {
    throw new Error(`APK size (${sizeBytes} bytes) is unexpectedly small.`);
  }
  const buf = readFileSync(apkPath);
  if (buf[0] !== 0x50 || buf[1] !== 0x4b || buf[2] !== 0x03 || buf[3] !== 0x04) {
    throw new Error('Output APK does not have a valid PKZIP header.');
  }

  // Verify required bundled web assets, AndroidManifest.xml, and APK Signature Scheme v2/v3 block
  const rawLatin1 = buf.toString('latin1');
  const requiredEntries = [
    'AndroidManifest.xml',
    'classes.dex',
    'assets/panel/sidepanel.html',
    'assets/panel/content.js',
    'APK Sig Block 42',
  ];
  for (const entry of requiredEntries) {
    if (!rawLatin1.includes(entry)) {
      throw new Error(`APK archive is missing required entry or signature block: ${entry}`);
    }
  }
  return sizeBytes;
}

export function resolveReleaseApkTargets(releaseDirPath = releaseDir, version = '1.0.0') {
  const cleanVersion = String(version || '1.0.0')
    .trim()
    .replace(/^v/i, '') || '1.0.0';
  return [
    resolve(releaseDirPath, 'chaos-tamer-android.apk'),
    resolve(releaseDirPath, `chaos-tamer-android-v${cleanVersion}.apk`),
  ];
}

export function copyAndVerifyReleaseApks(
  builtApk = builtApkPath,
  releaseDirPath = releaseDir,
  version = '1.0.0',
) {
  if (!existsSync(builtApk)) {
    throw new Error(`Expected Gradle release APK at ${builtApk}, but file was not found.`);
  }
  mkdirSync(releaseDirPath, { recursive: true });
  const targets = resolveReleaseApkTargets(releaseDirPath, version);
  let sizeBytes = 0;
  for (const targetPath of targets) {
    copyFileSync(builtApk, targetPath);
    sizeBytes = verifyApkArchive(targetPath);
  }
  return { targets, sizeBytes };
}

export function main() {
  const sdkRoot = resolveAndroidSdkRoot();
  if (!sdkRoot) {
    throw new Error(
      'Android SDK not found. Set ANDROID_HOME / ANDROID_SDK_ROOT or install into .android-toolchain/sdk.',
    );
  }

  const pkg = JSON.parse(readFileSync(resolve(rootDir, 'package.json'), 'utf8'));
  const keystoreConfig = resolveKeystoreConfig();
  const keystoreResult = ensureReleaseKeystore(keystoreConfig);
  const relKeystore = relative(rootDir, keystoreResult.keystoreFile).split(sep).join('/');
  if (keystoreResult.generated) {
    console.log(`[build-android-apk] Generated signing keystore at ${relKeystore}.`);
  } else if (keystoreResult.restoredFromBase64) {
    console.log(`[build-android-apk] Restored signing keystore from CHAOS_TAMER_KEYSTORE_BASE64 at ${relKeystore}.`);
  } else {
    console.log(`[build-android-apk] Using existing signing keystore at ${relKeystore}.`);
  }

  runStep('node', ['scripts/generate-android-icons.mjs'], rootDir);
  runStep('npm', ['run', 'build'], rootDir);
  runStep('node', ['scripts/sync-android-assets.mjs'], rootDir);

  const gradlew = process.platform === 'win32' ? '.\\gradlew.bat' : './gradlew';
  runStep(gradlew, ['testReleaseUnitTest', 'assembleRelease'], androidDir, {
    ANDROID_HOME: sdkRoot,
    ANDROID_SDK_ROOT: sdkRoot,
    CHAOS_TAMER_KEYSTORE_PATH: keystoreConfig.keystoreFile,
    CHAOS_TAMER_KEYSTORE_PASSWORD: keystoreConfig.storePassword,
    CHAOS_TAMER_KEY_ALIAS: keystoreConfig.keyAlias,
    CHAOS_TAMER_KEY_PASSWORD: keystoreConfig.keyPassword,
  });

  const { targets, sizeBytes } = copyAndVerifyReleaseApks(
    builtApkPath,
    releaseDir,
    pkg.version,
  );
  const sizeMb = (sizeBytes / (1024 * 1024)).toFixed(2);
  const relTargets = targets.map((p) => relative(rootDir, p).split(sep).join('/'));
  console.log(
    `[build-android-apk] OK — Built & verified ${relTargets.join(' + ')} (${sizeMb} MB).`,
  );
}

function normalizeExecPath(filePath) {
  let canonical;
  try {
    canonical = realpathSync(filePath);
  } catch {
    canonical = resolve(filePath);
  }
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

const isDirectExecution =
  Boolean(process.argv[1]) && normalizeExecPath(process.argv[1]) === normalizeExecPath(__filename);

if (isDirectExecution) {
  main();
}
