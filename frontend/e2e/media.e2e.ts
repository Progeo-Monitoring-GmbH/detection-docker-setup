import { expect, test } from './fixtures';
import { apiCall, e2eInfo, logIn, roleReady, roleState, STAFF_STATE, tokenOf } from './roles';

/**
 * Files under /media/ (backend AuthenticatedMediaView) need a login, and
 * backups (/media/backup/...) a superuser. The internal /protected-media/
 * (nginx X-Accel-Redirect target) is never reachable from outside.
 * Only API requests - no page.
 */
const BACKUP = '/media/backup/e2e-does-not-exist.zip';

/** The session's JWT claims (the SPA's authToken). */
const claimsOf = (stateFile: string): Record<string, unknown> => {
  const token = tokenOf(stateFile);
  if (!token) {
    return {};
  }
  const payload = token.split('.')[1] || '';
  return JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8'));
};

test('without a login no media file is served', async ({ request, baseURL }) => {
  const sample = e2eInfo()?.media_sample;
  test.skip(!sample, 'needs the e2e info (E2E_DEMO_PASSWORD, e2e/README.md)');
  const response = await apiCall(request, baseURL, 'GET', sample as string, null);
  expect(response.status()).toBe(403);
});

test('without a login no backup is served', async ({ request, baseURL }) => {
  const response = await apiCall(request, baseURL, 'GET', BACKUP, null);
  expect(response.status()).toBe(403);
});

test('a customer gets the own files, but no backup', async ({ request, baseURL }) => {
  const info = e2eInfo();
  test.skip(!info?.media_sample || !roleReady('customer'), 'needs the customer test user');
  const own = await apiCall(request, baseURL, 'GET', info!.media_sample as string, roleState('customer'));
  expect(own.status(), 'the demo plan of the own location').toBe(200);
  const backup = await apiCall(request, baseURL, 'GET', BACKUP, roleState('customer'));
  expect(backup.status()).toBe(403);
});

test('backups only for superusers', async ({ request, baseURL }) => {
  const response = await apiCall(request, baseURL, 'GET', BACKUP, STAFF_STATE);
  // The file doesn't exist: a superuser gets past the check (404), staff is refused (403).
  const superuser = claimsOf(STAFF_STATE).is_superuser === true;
  expect(response.status()).toBe(superuser ? 404 : 403);
});

test('a superuser login (E2E_SUPERUSER_*) gets past the backup check', async ({ browser, request, baseURL }) => {
  const username = process.env.E2E_SUPERUSER_USERNAME;
  const password = process.env.E2E_SUPERUSER_PASSWORD;
  test.skip(!username || !password, 'set E2E_SUPERUSER_USERNAME / E2E_SUPERUSER_PASSWORD (a superuser without 2FA)');
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await logIn(page, username as string, password as string);
  const token = await page.evaluate(() => localStorage.getItem('authToken'));
  await context.close();
  const response = await request.fetch(`${(process.env.E2E_API_URL || baseURL || '').replace(/\/$/, '')}${BACKUP}`, {
    headers: { Authorization: `Bearer ${token}` },
    failOnStatusCode: false,
  });
  expect(response.status()).toBe(404);
});

test('the internal /protected-media/ is not reachable', async ({ request, baseURL }) => {
  const response = await apiCall(request, baseURL, 'GET', '/protected-media/backup/e2e-does-not-exist.zip', STAFF_STATE);
  // nginx: internal location -> 404. A dev server without nginx answers with the SPA (HTML).
  const html = (response.headers()['content-type'] || '').includes('text/html');
  expect(response.status() >= 400 || html, 'no file comes back').toBe(true);
  expect(response.headers()['content-type'] || '').not.toContain('application/zip');
});
