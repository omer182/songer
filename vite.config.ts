import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Build info shown in the corner of every screen. CI passes the commit as APP_VERSION (the Docker
// build has no .git); locally we ask git, and fall back to "dev".
const pkgVersion = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version;
function commit(): string {
  if (process.env.APP_VERSION) return process.env.APP_VERSION.slice(0, 7);
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'dev';
  }
}

// The web app lives in web/; the API server runs on 5100 and is proxied in dev.
export default defineConfig({
  root: 'web',
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkgVersion),
    __APP_COMMIT__: JSON.stringify(commit()),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  // Built files go under /play/assets so party guests need only one public path (/play/*).
  build: { outDir: '../dist/web', emptyOutDir: true, assetsDir: 'play/assets' },
  server: {
    host: true, // phones on the LAN can reach /play in dev
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:5100',
      '/play/socket.io': { target: 'http://127.0.0.1:5100', ws: true },
      '/play/pair': 'http://127.0.0.1:5100', // one-time host-remote sign-in links
    },
  },
  test: { root: '.', include: ['shared/**/*.test.ts', 'server/**/*.test.ts'] },
});
