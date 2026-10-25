import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  timeout: 60_000,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:5373', viewport: { width: 1440, height: 900 } },
  webServer: {
    command: 'pnpm exec vite --host 127.0.0.1 --port 5373 --strictPort',
    url: 'http://127.0.0.1:5373',
    env: { VITE_TEST_API: '1' }, // exposes the read-only test window; production builds do not set it
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
