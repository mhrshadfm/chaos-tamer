import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const __dirname = dirname(fileURLToPath(import.meta.url));

function sidepanelRootRewritePlugin(): Plugin {
  return {
    name: 'chaos-tamer-sidepanel-root-rewrite',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url === '/') {
          req.url = '/sidepanel.html';
        } else if (req.url?.startsWith('/?')) {
          req.url = `/sidepanel.html${req.url.slice(1)}`;
        }
        next();
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url === '/') {
          req.url = '/sidepanel.html';
        } else if (req.url?.startsWith('/?')) {
          req.url = `/sidepanel.html${req.url.slice(1)}`;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [sidepanelRootRewritePlugin(), react()],
  publicDir: 'public',
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    target: 'es2022',
    rollupOptions: {
      input: {
        sidepanel: resolve(__dirname, 'sidepanel.html'),
      },
    },
  },
});
