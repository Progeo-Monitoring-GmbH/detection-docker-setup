import fs from 'node:fs';
import { test as setup } from '@playwright/test';
import { apiCall, INFO_FILE, LOGGED_OUT, logIn, roleState, ROLES, STAFF_STATE, type E2EInfo } from './roles';

/**
 * Logs every test user in once and stores the sessions (tokens and the
 * privacy choice live in localStorage) - playwright.config.ts, e2e/roles.ts:
 *   - the staff user E2E_USERNAME / E2E_PASSWORD (e2e/.auth/user.json),
 *   - the ids of the demo test accounts (/v1/e2e/info/, staff only),
 *   - with E2E_DEMO_PASSWORD: the demo roles (e2e/.auth/<role>.json).
 * A role that can't log in gets an empty session; its tests skip.
 */
setup.describe.configure({ mode: 'serial' });

setup('log in', async ({ page }) => {
  const username = process.env.E2E_USERNAME;
  const password = process.env.E2E_PASSWORD;
  if (!username || !password) {
    throw new Error('Set E2E_USERNAME and E2E_PASSWORD (a test user without 2FA) - see e2e/README.md');
  }
  await logIn(page, username, password);
  await page.context().storageState({ path: STAFF_STATE });
});

setup('e2e info', async ({ request, baseURL }) => {
  const response = await apiCall(request, baseURL, 'GET', '/v1/e2e/info/', STAFF_STATE);
  const info = response.ok() ? ((await response.json()) as E2EInfo) : null;
  if (!info) {
    console.warn(`/v1/e2e/info/ answered ${response.status()} - E2E_DEMO_PASSWORD set on the server? The role tests skip.`);
  }
  fs.writeFileSync(INFO_FILE, JSON.stringify(info || {}, null, 2));
});

for (const role of ROLES) {
  setup(`log in as ${role}`, async ({ page }) => {
    const password = process.env.E2E_DEMO_PASSWORD;
    let info: E2EInfo | null = null;
    try {
      info = JSON.parse(fs.readFileSync(INFO_FILE, 'utf-8'));
    } catch {
      info = null;
    }
    const email = info?.users?.[role]?.email;
    if (!password || !email) {
      fs.writeFileSync(roleState(role), JSON.stringify(LOGGED_OUT));
      setup.skip(true, 'Set E2E_DEMO_PASSWORD (and on the server) for the role tests - e2e/README.md');
      return;
    }
    await logIn(page, email, password);
    await page.context().storageState({ path: roleState(role) });
  });
}
