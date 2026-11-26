import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    target: 'es2022',
    rollupOptions: {
      input: resolve(__dirname, 'src/background/index.ts'),
      output: {
        entryFileNames: 'background.js',
        format: 'es',
        inlineDynamicImports: true,
      },
    },
  },
});
