import { defineConfig, devices } from '@playwright/test';

const APP_PORT = 4400;
const BASE_URL = `http://localhost:${APP_PORT}`;

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  /**
   * One worker, deliberately. writeback.spec.ts and queue.spec.ts each start
   * their own JIRA stub on the same fixed port (the single running app
   * server reads JIRA_BASE_URL once at boot, so every test has to point at
   * one port) - two workers would race to bind it. The two `setup` project
   * tests have the same requirement in the other direction: the member
   * sign-in depends on the admin sign-in's storageState file already being
   * written. A single worker makes both races impossible rather than rare.
   */
  workers: 1,
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'bash scripts/start-app.sh',
    url: `${BASE_URL}/healthz`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  projects: [
    {
      name: 'setup',
      testMatch: /auth\.setup\.ts/,
    },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['setup'],
    },
  ],
});
