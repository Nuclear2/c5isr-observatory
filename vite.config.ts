import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'bundled-replays',
      apply: 'build',
      generateBundle() {
        for (const fileName of ['examples/two-node-replay.json', 'examples/evidence-review.json']) {
          this.emitFile({ type: 'asset', fileName, source: readFileSync(new URL(fileName, import.meta.url)) });
        }
      },
    },
  ],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false } },
  },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
});
