import { defineConfig, devices } from '@playwright/test';

/**
 * UI tests (Playwright) - see e2e/README.md. Elements are found by their
 * data-testid (src/testIds.ts). The "setup" project logs in once
 * (e2e/auth.setup.ts) and the tests reuse that session (storageState).
 *
 *   E2E_BASE_URL   the frontend to test (default: the local dev server, started if not running)
 *   E2E_USERNAME   login of the test user (without 2FA)
 *   E2E_PASSWORD
 *   E2E_LOCATION_ID  optional: a location the user sees, for the location pages
 */
const baseURL = process.env.E2E_BASE_URL || 'http://localhost:3000';
const AUTH_FILE = 'e2e/.auth/user.json';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  outputDir: 'e2e/test-results',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [['list'], ['html', { outputFolder: 'e2e/report', open: 'never' }]],
  use: {
    baseURL,
    testIdAttribute: 'data-testid',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'de-DE',
    timezoneId: 'Europe/Berlin',
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], storageState: AUTH_FILE },
      dependencies: ['setup'],
    },
  ],
  // Without E2E_BASE_URL: the local dev server (reused when it already runs).
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: 'npm run start',
        url: baseURL,
        reuseExistingServer: true,
        timeout: 120_000,
      },
});
