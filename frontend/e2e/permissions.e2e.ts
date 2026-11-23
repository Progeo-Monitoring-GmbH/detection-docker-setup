import type { Page } from '@playwright/test';
import { expect, openPage, test, toasts } from './fixtures';
import { apiCall, e2eInfo, grantInBrowser, roleReady, roleState, STAFF_STATE, type E2EInfo, type Role } from './roles';

/**
 * The permission system seen from the browser: users without a right try
 * what it would allow. The server must refuse (checked on the API as well)
 * and the app must say so with an error toast and keep the user on the page.
 *
 * Users: the demo test roles (e2e/roles.ts). Where the app hides a button
 * from a user without the right, the test first checks that it is hidden,
 * then shows it anyway (grantInBrowser - only the browser believes the user
 * has the right) and clicks it.
 *
 * Every target is chosen so that even a wrongly allowed action does no harm:
 * demo data, an unchanged value, the empty E2E target location, a user in no
 * account (helper/e2e.py).
 */

const SMARTEX_DM = '9001'; // the "single" role's only location
const SMARTEX_IS = '9002';

/** The e2e ids and the role's session - skips the test without them. */
const needRole = (role: Role): E2EInfo => {
  const info = e2eInfo();
  test.skip(!info || !roleReady(role), `needs the ${role} test user (E2E_DEMO_PASSWORD, e2e/README.md)`);
  return info as E2EInfo;
};

const locationOf = (info: E2EInfo, projectId: string) => {
  const id = info.locations[projectId];
  test.skip(!id, `demo location ${projectId} missing - run demo_account on the server`);
  return id;
};

/** The action ends in an error toast, and the user is still where they were. */
const expectRefusedInUi = async (page: Page, action: () => Promise<void>) => {
  const before = page.url();
  await action();
  await expect(toasts(page, 'error').first(), 'an error toast says the action was refused').toBeVisible();
  expect(page.url(), 'the user stays on the page').toBe(before);
  await expect(page).not.toHaveURL(/\/login/);
};

test.describe('a customer without the rights', () => {
  test.use({ storageState: roleState('customer') });

  test('sees the own locations (control)', async ({ page }) => {
    const info = needRole('customer');
    await openPage(page, `/location/${locationOf(info, SMARTEX_DM)}/status`, 'page-location-status');
    await expect(page.getByTestId('location-no-access')).toHaveCount(0);
  });

  test('cannot revoke another user', async ({ page, request, baseURL }) => {
    const info = needRole('customer');
    const location = locationOf(info, SMARTEX_DM);
    const target = info.users.subscriber.id;
    test.skip(!target, 'the subscriber test user is missing');
    const path = `/v1/location/${location}/access/delete/`;

    const api = await apiCall(request, baseURL, 'POST', path, roleState('customer'), {
      user_id: target,
      scope: 'account',
    });
    expect(api.status(), 'the server refuses the revoke').toBe(403);

    // Hidden in the app ...
    await openPage(page, `/location/${location}/permissions`, 'page-location-rechte');
    await expect(page.getByTestId('rechte-list')).toBeVisible();
    await expect(page.getByTestId('rechte-revoke')).toHaveCount(0);

    // ... and refused when the browser shows it anyway.
    await grantInBrowser(page, ['module_user_revokable', 'module_notifications_edit']);
    await openPage(page, `/location/${location}/permissions`, 'page-location-rechte');
    const revoke = page.getByTestId('rechte-revoke').and(page.locator(`[data-test-key="${target}"]`));
    await expect(revoke).toBeVisible();
    await expectRefusedInUi(page, async () => {
      await revoke.click();
      await page.getByTestId('rechte-revoke-dialog-confirm').click();
    });

    const members = await apiCall(request, baseURL, 'GET', `/v1/location/${location}/access/`, STAFF_STATE);
    const ids = ((await members.json()).members || []).map((member: { user_id: number }) => member.user_id);
    expect(ids, 'the user keeps the access').toContain(target);
  });

  test("cannot generate another user's password", async ({ page, request, baseURL }) => {
    const info = needRole('customer');
    test.skip(!info.outsider_id, 'the outsider test user is missing');
    const api = await apiCall(
      request,
      baseURL,
      'POST',
      `/api/auth-support/staff/users/${info.outsider_id}/password/`,
      roleState('customer'),
      {},
    );
    expect(api.status(), 'the server refuses the new password').toBe(403);
    expect(await api.text()).not.toContain('new_password');

    // The user administration isn't the customer's: no way to the button.
    await page.goto('/staff/');
    await page.waitForLoadState('networkidle');
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.getByTestId('staff-user-generate-password')).toHaveCount(0);
  });

  test('cannot edit location details', async ({ page, request, baseURL }) => {
    const info = needRole('customer');
    const location = locationOf(info, SMARTEX_DM);
    const read = await apiCall(request, baseURL, 'GET', `/v1/location/${location}/`, roleState('customer'));
    expect(read.status()).toBe(200);
    const city: string = (await read.json()).city ?? '';

    // The value stays the same - a wrongly allowed change would change nothing.
    const api = await apiCall(request, baseURL, 'PATCH', `/v1/location/${location}/`, roleState('customer'), {
      city,
    });
    expect(api.status(), 'the server refuses the change').toBe(403);

    await openPage(page, `/location/${location}/object`, 'page-location-objekt');
    await expect(page.getByTestId('objekt-no-permission')).toBeVisible();
    await expect(page.getByTestId('objekt-save')).toHaveCount(0);

    await grantInBrowser(page, ['module_locations_edit']);
    await openPage(page, `/location/${location}/object`, 'page-location-objekt');
    await expect(page.getByTestId('objekt-save')).toBeVisible();
    await expectRefusedInUi(page, async () => {
      await page.getByTestId('objekt-save').click();
    });
  });

  test('cannot delete a location', async ({ page, request, baseURL }) => {
    const info = needRole('customer');
    const target = info.target_location_id;
    test.skip(!target, 'the E2E target location is missing - run demo_account --e2e on the server');

    const api = await apiCall(request, baseURL, 'DELETE', `/v1/location/${target}/`, roleState('customer'));
    expect(api.status(), 'the server refuses the delete').toBe(403);
    const still = await apiCall(request, baseURL, 'GET', `/v1/location/${target}/`, STAFF_STATE);
    expect(still.status(), 'the location still exists').toBe(200);

    // Customers get no delete control at all (locations are deleted by staff).
    await openPage(page, `/location/${target}/status`, 'page-location-status');
    await expect(page.getByTestId('location-portal-django-delete')).toHaveCount(0);
  });

  test("cannot open another account's location", async ({ page, request, baseURL }) => {
    const info = needRole('customer');
    const foreign = info.foreign_location_id;
    test.skip(!foreign, 'no location of another account on this server');

    const api = await apiCall(request, baseURL, 'GET', `/v1/location/${foreign}/`, roleState('customer'));
    expect([403, 404], 'the server hides the location').toContain(api.status());

    await page.goto(`/location/${foreign}/status`);
    await expect(page.getByTestId('location-no-access')).toBeVisible();
    await expect(toasts(page, 'error').first()).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/location/${foreign}/status`));
  });
});

test.describe('a user with access to one location', () => {
  test.use({ storageState: roleState('single') });

  test('sees that location (control)', async ({ page }) => {
    const info = needRole('single');
    await openPage(page, `/location/${locationOf(info, SMARTEX_DM)}/status`, 'page-location-status');
    await expect(page.getByTestId('location-no-access')).toHaveCount(0);
  });

  test('cannot open a location outside the own scope', async ({ page, request, baseURL }) => {
    const info = needRole('single');
    const other = locationOf(info, SMARTEX_IS);

    const api = await apiCall(request, baseURL, 'GET', `/v1/location/${other}/`, roleState('single'));
    expect([403, 404], 'the server hides the location').toContain(api.status());

    await page.goto(`/location/${other}/status`);
    await expect(page.getByTestId('location-no-access')).toBeVisible();
    await expect(toasts(page, 'error').first()).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/location/${other}/status`));
  });
});
