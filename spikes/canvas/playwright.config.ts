import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests',
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:5174',
    viewport: { width: 1000, height: 700 },
    // Pre-installed Chromium in the probe environment; recorded in the probe README.
    launchOptions: process.env.PROBE_CHROMIUM ? { executablePath: process.env.PROBE_CHROMIUM } : {},
  },
  webServer: { command: 'npx vite --port 5174 --strictPort --host 127.0.0.1', url: 'http://127.0.0.1:5174', reuseExistingServer: false },
});
