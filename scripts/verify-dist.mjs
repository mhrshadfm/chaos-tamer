import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const distDir = resolve(rootDir, 'dist');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const REQUIRED_FILES = [
  'manifest.json',
  'background.js',
  'content.js',
  'sidepanel.html',
  'icons/logo-white.png',
  'icons/icon-16.png',
  'icons/icon-32.png',
  'icons/icon-48.png',
  'icons/icon-128.png',
];

const EXPECTED_PNG_SIZES = {
  'icons/logo-white.png': 256,
  'icons/icon-16.png': 16,
  'icons/icon-32.png': 32,
  'icons/icon-48.png': 48,
  'icons/icon-128.png': 128,
};

const errors = [];

for (const relPath of REQUIRED_FILES) {
  const fullPath = resolve(distDir, relPath);
  if (!existsSync(fullPath)) {
    errors.push(`Missing required build artifact: dist/${relPath}`);
    continue;
  }
  const st = statSync(fullPath);
  if (!st.isFile() || st.size === 0) {
    errors.push(`Empty or invalid build artifact: dist/${relPath}`);
  }
}

for (const [relPath, expectedDim] of Object.entries(EXPECTED_PNG_SIZES)) {
  const fullPath = resolve(distDir, relPath);
  if (!existsSync(fullPath)) continue;
  const buf = readFileSync(fullPath);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    errors.push(`Invalid PNG magic header in dist/${relPath}`);
    continue;
  }
  const chunkType = buf.subarray(12, 16).toString('ascii');
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  if (chunkType !== 'IHDR' || w !== expectedDim || h !== expectedDim) {
    errors.push(`Unexpected PNG dimensions in dist/${relPath}: got ${w}x${h}, expected ${expectedDim}x${expectedDim}`);
  }
}

const manifestPath = resolve(distDir, 'manifest.json');
if (existsSync(manifestPath)) {
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest.manifest_version !== 3) {
      errors.push(`Expected manifest_version 3, got ${manifest.manifest_version}`);
    }
    if (manifest.name !== 'Chaos Tamer') {
      errors.push(`Expected manifest name "Chaos Tamer", got "${manifest.name}"`);
    }
    if (manifest.author !== '@mhrshadfm') {
      errors.push(`Expected manifest author "@mhrshadfm", got "${manifest.author}"`);
    }
    if (manifest.background?.service_worker !== 'background.js') {
      errors.push('Manifest background.service_worker must be "background.js"');
    }
    if (manifest.side_panel?.default_path !== 'sidepanel.html') {
      errors.push('Manifest side_panel.default_path must be "sidepanel.html"');
    }
    if (!Array.isArray(manifest.content_scripts) || !manifest.content_scripts[0]?.js?.includes('content.js')) {
      errors.push('Manifest content_scripts must include "content.js"');
    }
  } catch (err) {
    errors.push(`Failed to parse dist/manifest.json: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const contentScriptPath = resolve(distDir, 'content.js');
if (existsSync(contentScriptPath)) {
  const contentJs = readFileSync(contentScriptPath, 'utf8');
  if (/^\s*(import|export)\b/m.test(contentJs)) {
    errors.push('dist/content.js contains top-level ES module import/export statements; must be a self-contained IIFE.');
  }
}

if (errors.length > 0) {
  console.error('[verify-dist] Verification FAILED:');
  for (const e of errors) {
    console.error(`  - ${e}`);
  }
  process.exit(1);
}

console.log(`[verify-dist] OK — Verified ${REQUIRED_FILES.length} MV3 artifacts, PNG headers, manifest, and standalone IIFE content.js.`);
