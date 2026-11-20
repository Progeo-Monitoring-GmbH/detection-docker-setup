import fs from 'node:fs';
import { expect, type APIRequestContext, type Page } from '@playwright/test';

/**
 * The test users besides the staff user (E2E_USERNAME): people of the demo
 * account on staging (backend: progeo/helper/e2e.py, `demo_account --e2e`).
 * They share the password E2E_DEMO_PASSWORD. auth.setup.ts logs each in once
 * (e2e/.auth/<role>.json) and stores the ids the tests need
 * (e2e/.auth/e2e-info.json, from the staff-only /v1/e2e/info/).
 *
 *   customer    account member with a customer's usual rights: may look,
 *               not edit, delete, revoke or invite
 *   single      access to the smartex dm demo location (project 9001) only
 *   subscriber  account member with alarm mails (the unsubscribe test)
 */
export type Role = 'customer' | 'single' | 'subscriber';
export const ROLES: Role[] = ['customer', 'single', 'subscriber'];

export const AUTH_DIR = 'e2e/.auth';
export const STAFF_STATE = `${AUTH_DIR}/user.json`;
export const INFO_FILE = `${AUTH_DIR}/e2e-info.json`;
export const roleState = (role: Role) => `${AUTH_DIR}/${role}.json`;

/** An empty session (logged out) - also what a role's file holds when it couldn't log in. */
export const LOGGED_OUT = { cookies: [], origins: [] };

export type E2EInfo = {
  account_id: number;
  media_sample: string | null;
  /** demo location ids by project id: "9001" smartex dm, "9002" smartex is, ... */
  locations: Record<string, number>;
  target_location_id: number | null;
  foreign_location_id: number | null;
  users: Record<Role, { id: number | null; email: string }>;
  outsider_id: number | null;
};

/** The ids of e2e-info.json - null without them (E2E_DEMO_PASSWORD unset, or /v1/e2e/ off on the server). */
export const e2eInfo = (): E2EInfo | null => {
  try {
    const info = JSON.parse(fs.readFileSync(INFO_FILE, 'utf-8'));
    return info && info.locations ? (info as E2EInfo) : null;
  } catch {
    return null;
  }
};

/** Whether `role` could log in (auth.setup.ts) - its tests are skipped otherwise. */
export const roleReady = (role: Role) => {
  try {
    const state = JSON.parse(fs.readFileSync(roleState(role), 'utf-8'));
    return (state.origins || []).length > 0;
  } catch {
    return false;
  }
};

/** The SPA's JWT (localStorage authToken) of a stored session. */
export const tokenOf = (stateFile: string): string | null => {
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    for (const origin of state.origins || []) {
      const entry = (origin.localStorage || []).find((item: { name: string }) => item.name === 'authToken');
      if (entry) {
        return entry.value;
      }
    }
  } catch {
    // no session
  }
  return null;
};

/** The backend: E2E_API_URL, else the frontend's origin (nginx routes /v1, /api and /media). */
export const apiUrl = (baseURL: string | undefined, path: string) =>
  `${(process.env.E2E_API_URL || baseURL || '').replace(/\/$/, '')}${path}`;

/** Request headers of a stored session (none when logged out). */
export const authHeaders = (stateFile: string | null): Record<string, string> => {
  const token = stateFile ? tokenOf(stateFile) : null;
  return token ? { Authorization: `Bearer ${token}` } : {};
};

/** GET/POST/... `path` on the backend as the session `stateFile` (null: logged out). */
export const apiCall = async (
  request: APIRequestContext,
  baseURL: string | undefined,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  stateFile: string | null,
  data?: unknown,
) =>
  request.fetch(apiUrl(baseURL, path), {
    method,
    headers: { ...authHeaders(stateFile), 'Content-Type': 'application/json' },
    data: data === undefined ? undefined : JSON.stringify(data),
    failOnStatusCode: false,
    maxRedirects: 0,
  });

/** The login form (with the privacy banner out of the way); fails on 2FA. */
export const logIn = async (page: Page, email: string, password: string) => {
  await page.goto('/login');
  const banner = page.getByTestId('cookie-banner');
  if (await banner.isVisible().catch(() => false)) {
    await page.getByTestId('cookie-banner-reject').click();
  }
  await page.getByTestId('login-username').fill(email);
  await page.getByTestId('login-password').fill(password);
  await page.getByTestId('login-submit').click();
  if (await page.getByTestId('login-otp-form').isVisible({ timeout: 2_000 }).catch(() => false)) {
    throw new Error(`${email} has 2FA - the e2e users must not (e2e/README.md)`);
  }
  await expect(page).not.toHaveURL(/\/login/);
};

/**
 * Shows the UI of permissions the user doesn't hold: the module permissions
 * the app downloads get `codes` added in the browser - the server still
 * decides with the real ones. This is how a test reaches a button the user
 * normally doesn't see, to check that the server refuses and the app says so.
 * Call before the page loads.
 */
export const grantInBrowser = async (page: Page, codes: string[]) => {
  await page.route('**/api/auth-support/module-permissions/**', async (route) => {
    const response = await route.fetch();
    const payload = await response.json().catch(() => ({}));
    const permissions = { ...(payload.permissions || {}) };
    for (const code of codes) {
      permissions[code] = true;
    }
    const enabled = Array.from(new Set([...(payload.enabled || []), ...codes]));
    await route.fulfill({ response, json: { ...payload, permissions, enabled } });
  });
};
