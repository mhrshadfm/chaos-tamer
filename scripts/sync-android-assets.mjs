import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const distDir = resolve(rootDir, 'dist');
const androidPanelAssetsDir = resolve(
  rootDir,
  'android',
  'app',
  'src',
  'main',
  'assets',
  'panel',
);

const REQUIRED_DIST_ITEMS = ['sidepanel.html', 'content.js', 'assets', 'icons'];

for (const item of REQUIRED_DIST_ITEMS) {
  if (!existsSync(resolve(distDir, item))) {
    throw new Error(
      `Missing dist/${item}. Run "npm run build" before syncing Android assets.`,
    );
  }
}

if (existsSync(androidPanelAssetsDir)) {
  rmSync(androidPanelAssetsDir, { recursive: true, force: true });
}
mkdirSync(androidPanelAssetsDir, { recursive: true });

for (const item of REQUIRED_DIST_ITEMS) {
  cpSync(resolve(distDir, item), resolve(androidPanelAssetsDir, item), { recursive: true });
}

console.log(
  `[sync-android-assets] Synced sidepanel.html, assets/, icons/, and content.js -> android/app/src/main/assets/panel/`,
);
