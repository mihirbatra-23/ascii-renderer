import { defineConfig } from '@playwright/test';

// End-to-end tests run against the Vite dev server in the locally installed Chrome
// (channel: 'chrome'), so no browser download is needed.
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    channel: 'chrome',
    headless: true,
    viewport: { width: 1440, height: 900 },
    launchOptions: { args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] },
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
