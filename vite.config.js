import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const buildDate = process.env.WORKER_BUILD_DATE || new Date().toISOString().slice(0, 10);

export default defineConfig({
  base: './',
  plugins: [react()],
  define: {
    __APP_BUILD_DATE__: JSON.stringify(buildDate),
    __APP_VERSION_FALLBACK__: JSON.stringify(pkg.version),
  },
  build: {
    outDir: 'dist-renderer',
    emptyOutDir: true,
    sourcemap: false,
  }
});
