import { defineConfig } from 'vite';

// Packaged output is served by WebView2 from https://app.agentic-diagram.invalid/ (fixed origin).
export default defineConfig({
  base: './',
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false, chunkSizeWarningLimit: 4000 },
  server: { host: '127.0.0.1' },
});
