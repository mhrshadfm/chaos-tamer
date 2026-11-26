import { existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const distDir = resolve(rootDir, 'dist');

if (existsSync(distDir)) {
  rmSync(distDir, { recursive: true, force: true });
  console.log('[clean] Removed dist/');
} else {
  console.log('[clean] dist/ already clean');
}
