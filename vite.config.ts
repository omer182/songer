import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The web app lives in web/; the API server runs on 5100 and is proxied in dev.
export default defineConfig({
  root: 'web',
  plugins: [react()],
  // Built files go under /play/assets so party guests need only one public path (/play/*).
  build: { outDir: '../dist/web', emptyOutDir: true, assetsDir: 'play/assets' },
  server: {
    host: true, // phones on the LAN can reach /play in dev
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:5100',
      '/play/socket.io': { target: 'http://127.0.0.1:5100', ws: true },
    },
  },
  test: { root: '.', include: ['shared/**/*.test.ts', 'server/**/*.test.ts'] },
});
