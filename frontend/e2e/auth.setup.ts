import { expect, test as setup } from '@playwright/test';

/**
 * Logs the test user in once and stores the session (tokens and the privacy
 * choice live in localStorage) for every test - playwright.config.ts.
 */
const AUTH_FILE = 'e2e/.auth/user.json';

setup('log in', async ({ page }) => {
  const username = process.env.E2E_USERNAME;
  const password = process.env.E2E_PASSWORD;
  if (!username || !password) {
    throw new Error('Set E2E_USERNAME and E2E_PASSWORD (a test user without 2FA) - see e2e/README.md');
  }

  await page.goto('/login');
  // The privacy banner covers the page until a choice is made.
  const banner = page.getByTestId('cookie-banner');
  if (await banner.isVisible().catch(() => false)) {
    await page.getByTestId('cookie-banner-reject').click();
  }

  await page.getByTestId('login-username').fill(username);
  await page.getByTestId('login-password').fill(password);
  await page.getByTestId('login-submit').click();

  if (await page.getByTestId('login-otp-form').isVisible({ timeout: 2_000 }).catch(() => false)) {
    throw new Error('The test user has 2FA - use one without (e2e/README.md)');
  }
  await expect(page).not.toHaveURL(/\/login/);
  await page.context().storageState({ path: AUTH_FILE });
});
