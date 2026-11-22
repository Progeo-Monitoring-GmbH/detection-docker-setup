import type { Page } from '@playwright/test';
import { expect, expectConfirmGuard, openPage, test, toasts } from './fixtures';
import { apiCall, e2eInfo, grantInBrowser, roleReady, roleState, type Role } from './roles';

/**
 * The login QR code in Mein Konto (module_profile_qr_code, /v1/user/qr-code/):
 * the user's own login token as a QR code of {"token": "..."}.
 *
 *   customer    does not hold the permission: no button, and the server
 *               refuses when the browser shows it anyway (grantInBrowser)
 *   subscriber  holds it (helper/e2e.py): generates the code, sees it, hides
 *               it and finds "QR-Code zeigen" the next time; revokes it
 *               (asked first) and gets a new one
 *
 * The only thing these tests leave behind is the login token of the
 * subscriber test user - a person of the demo account.
 */

const START = ['/location/overview/', 'page-location-overview'] as const;
const QR_PATH = '/v1/user/qr-code/';
const REVOKE_PATH = '/v1/user/qr-code/revoke/';
const PERMISSION = 'module_profile_qr_code';

const needRole = (role: Role) => {
  test.skip(!e2eInfo() || !roleReady(role), `needs the ${role} test user (E2E_DEMO_PASSWORD, e2e/README.md)`);
};

/** Opens Mein Konto from the top bar and waits for the loaded profile. */
const openProfile = async (page: Page) => {
  await openPage(page, ...START);
  await page.getByTestId('topbar-account').click();
  await expect(page.getByTestId('user-profile-contact')).toBeVisible();
};

const closeProfile = async (page: Page) => {
  await page.getByTestId('user-profile-close').click();
  await expect(page.getByTestId('user-profile-contact')).toBeHidden();
};

test.describe('a customer without the QR code permission', () => {
  test.use({ storageState: roleState('customer') });

  test('gets no QR code from the server', async ({ request, baseURL }) => {
    needRole('customer');

    const api = await apiCall(request, baseURL, 'POST', QR_PATH, roleState('customer'), {});

    expect(api.status(), 'the server refuses the QR code').toBe(403);
    const body = await api.json();
    expect(body.missing_permissions).toEqual([PERMISSION]);
    expect(body.qr, 'no code in a refusal').toBeUndefined();

    const revoke = await apiCall(request, baseURL, 'POST', REVOKE_PATH, roleState('customer'), {});
    expect(revoke.status(), 'the server refuses the revoke, too').toBe(403);
    expect((await revoke.json()).qr).toBeUndefined();
  });

  test('sees no QR code button, and is refused when the browser shows it', async ({ page }) => {
    needRole('customer');

    // Hidden in the app ...
    await openProfile(page);
    await expect(page.getByTestId('user-profile-qr-code')).toHaveCount(0);

    // ... and refused when the browser shows it anyway.
    await grantInBrowser(page, [PERMISSION]);
    await openProfile(page);
    const button = page.getByTestId('user-profile-qr-code-button');
    await expect(button).toBeVisible();
    await button.click();

    await expect(toasts(page, 'error').first(), 'an error toast says it was refused').toBeVisible();
    await expect(page.getByTestId('user-profile-qr-code-image')).toHaveCount(0);
    await expect(button, 'the button is usable again').toBeEnabled();
    await expect(page).not.toHaveURL(/\/login/);
  });
});

test.describe('a user with the QR code permission', () => {
  test.use({ storageState: roleState('subscriber') });
  // Both tests use the subscriber's one token: not at the same time.
  test.describe.configure({ mode: 'serial' });

  test('generates the QR code, hides it and finds it again', async ({ page, request, baseURL, expectUniqueTestIds }) => {
    needRole('subscriber');
    const profile = async () =>
      (await apiCall(request, baseURL, 'GET', '/v1/user/profile/', roleState('subscriber'))).json();
    // An earlier run may have created the token already.
    const existed = Boolean((await profile()).qr_code_exists);

    await openProfile(page);
    const section = page.getByTestId('user-profile-qr-code');
    test.skip(
      (await section.count()) === 0,
      `the subscriber test user lacks ${PERMISSION} - run "manage.py demo_account --e2e" on the server`,
    );
    const button = page.getByTestId('user-profile-qr-code-button');
    const image = page.getByTestId('user-profile-qr-code-image');
    await expect(button).toHaveText(existed ? /zeigen|show/i : /generieren|generate/i);
    await expect(image, 'the code is not shown before the click').toHaveCount(0);

    await button.click();

    await expect(image).toBeVisible();
    const shown = await image.getAttribute('src');
    expect(shown, 'a PNG image').toMatch(/^data:image\/png;base64,iVBOR/);
    expect(
      await image.evaluate((element) => (element as HTMLImageElement).naturalWidth),
      'the image loads',
    ).toBeGreaterThan(0);
    await expect(button).toHaveText(/ausblenden|hide/i);
    await expectUniqueTestIds();
    expect((await profile()).qr_code_exists, 'the user has a token now').toBe(true);

    // Hide it: gone from the page, the token stays.
    await button.click();
    await expect(image).toHaveCount(0);
    await expect(button).toHaveText(/zeigen|show/i);

    // The next time the profile opens, the same code is offered to show.
    await closeProfile(page);
    await page.getByTestId('topbar-account').click();
    await expect(page.getByTestId('user-profile-contact')).toBeVisible();
    await expect(button).toHaveText(/zeigen|show/i);
    await expect(image, 'the code is not kept open').toHaveCount(0);
    await button.click();
    await expect(image).toBeVisible();
    expect(await image.getAttribute('src'), 'the same token, not a new one').toBe(shown);
  });

  test('revoking asks first, then replaces the code', async ({ page }) => {
    needRole('subscriber');
    await openProfile(page);
    const section = page.getByTestId('user-profile-qr-code');
    test.skip(
      (await section.count()) === 0,
      `the subscriber test user lacks ${PERMISSION} - run "manage.py demo_account --e2e" on the server`,
    );
    const button = page.getByTestId('user-profile-qr-code-button');
    const image = page.getByTestId('user-profile-qr-code-image');
    const revoke = page.getByTestId('user-profile-qr-code-revoke');
    // Shows the current code (and creates the token when this test runs alone).
    await button.click();
    await expect(image).toBeVisible();
    const leaked = await image.getAttribute('src');

    // The dialog explains what happens; Cancel sends nothing and keeps the code.
    await expectConfirmGuard(page, {
      trigger: revoke,
      dialog: 'user-profile-qr-code-revoke-dialog',
      guarded: [{ url: REVOKE_PATH }],
    });
    expect(await image.getAttribute('src'), 'the code is unchanged after Cancel').toBe(leaked);

    // Now for real: the guard is lifted, the revoke reaches the server.
    await page.unrouteAll({ behavior: 'wait' });
    await revoke.click();
    await page.getByTestId('user-profile-qr-code-revoke-dialog-confirm').click();

    await expect(toasts(page, 'success').first(), 'a toast says the old code is void').toBeVisible();
    await expect(page.getByTestId('user-profile-qr-code-revoke-dialog')).toBeHidden();
    await expect(image).toBeVisible();
    await expect(image, 'a different code: a new token').not.toHaveAttribute('src', leaked as string);
    expect(await image.getAttribute('src')).toMatch(/^data:image\/png;base64,iVBOR/);

    // It is the token the server keeps: hiding and showing gives the new code again.
    const renewed = await image.getAttribute('src');
    await button.click();
    await expect(image).toHaveCount(0);
    await button.click();
    await expect(image).toHaveAttribute('src', renewed as string);
  });
});
