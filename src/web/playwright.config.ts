import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/browser',
  timeout: 60_000,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:5181',
    viewport: { width: 1400, height: 900 },
    launchOptions: process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
  },
  webServer: { command: 'npx vite --port 5181 --strictPort --host 127.0.0.1', url: 'http://127.0.0.1:5181', reuseExistingServer: !process.env.CI },
});
