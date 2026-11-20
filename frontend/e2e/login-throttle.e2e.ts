import type { Page, Response } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * Failed logins make the wait before the next attempt grow (backend
 * helper/login_throttle.py): 3 failures are free, then 2 s since the last
 * failure, 4 s after the next one, ... An attempt inside the wait is refused
 * unchecked (429, not counted) and the login page counts it down.
 *
 * Logged out, with a login name that doesn't exist (fresh per run): no real
 * account is touched, nothing to clean up - unknown names are throttled
 * like existing ones. Only 4 failed attempts: the server's per-IP limit (50
 * per 15 min) is shared with every other test.
 */
test.use({ storageState: { cookies: [], origins: [] } });

const randomName = () =>
  `e2e.throttle.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}@progeo.com`;

const isLoginRequest = (response: Response) =>
  response.request().method() === 'POST' &&
  new URL(response.url()).pathname.endsWith('/api/token/');

/** Sends the form with a wrong password; the answer of /api/token/. */
const wrongLogin = async (page: Page, name: string) => {
  await page.getByTestId('login-username').fill(name);
  await page.getByTestId('login-password').fill(`wrong-${Math.random().toString(36).slice(2)}`);
  const answer = page.waitForResponse(isLoginRequest);
  await page.getByTestId('login-submit').click();
  return answer;
};

const expectWrongCredentials = async (page: Page, response: Response) => {
  expect(response.status()).toBe(401);
  await expect(page.getByTestId('login-error')).toBeVisible();
  await expect(page.getByTestId('login-throttled')).toHaveCount(0);
};

/** The 429 and the countdown it starts; the seconds the server asked for. */
const expectThrottled = async (page: Page, response: Response) => {
  expect(response.status()).toBe(429);
  const body = await response.json();
  expect(body.code).toBe('login_throttled');
  expect(response.headers()['retry-after']).toBe(String(body.retry_after));

  const notice = page.getByTestId('login-throttled');
  await expect(notice).toBeVisible();
  await expect(page.getByTestId('login-error')).toHaveCount(0);
  await expect(page.getByTestId('login-submit')).toBeDisabled();
  const shown = Number(await notice.getAttribute('data-retry-after'));
  expect(shown).toBeGreaterThan(0);
  expect(shown).toBeLessThanOrEqual(body.retry_after);
  return body.retry_after as number;
};

test('failed logins make the wait grow', async ({ page, expectUniqueTestIds }) => {
  test.setTimeout(60_000);
  const name = randomName();

  await page.goto('/login');
  await expect(page.getByTestId('page-login')).toBeVisible();
  // The privacy banner covers the page until a choice is made.
  const banner = page.getByTestId('cookie-banner');
  if (await banner.isVisible().catch(() => false)) {
    await page.getByTestId('cookie-banner-reject').click();
  }

  // 3 failures are free: each answered as wrong credentials.
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await expectWrongCredentials(page, await wrongLogin(page, name));
  }

  // The 4th at once: refused, about 2 s to wait.
  const firstWait = await expectThrottled(page, await wrongLogin(page, name));
  await expectUniqueTestIds();
  expect(firstWait).toBeGreaterThanOrEqual(1);
  expect(firstWait).toBeLessThanOrEqual(2);

  // Waited out: the countdown ends, the next attempt is checked again.
  await expect(page.getByTestId('login-throttled')).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByTestId('login-submit')).toBeEnabled();
  await expectWrongCredentials(page, await wrongLogin(page, name));

  // At once again: the wait has doubled (about 4 s).
  const secondWait = await expectThrottled(page, await wrongLogin(page, name));
  expect(secondWait).toBeGreaterThanOrEqual(3);
  expect(secondWait).toBeLessThanOrEqual(4);
  expect(secondWait).toBeGreaterThan(firstWait);
});
