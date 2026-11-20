import type { Page } from '@playwright/test';
import { expect, openPage, test } from './fixtures';
import { apiCall, e2eInfo, roleReady, roleState, STAFF_STATE, type E2EInfo } from './roles';

/**
 * Unsubscribing with the link of an alarm mail (/notification/<token>?action=unsubscribe):
 * before, the subscriber gets alarm notifications for the location; the link,
 * opened without a login as from the mail, takes them off; after, the
 * subscriber's own settings show it - and they switch it on again, which
 * restores the start for the next run.
 *
 * The link: the staff-only /v1/e2e/notification-link/ makes one as the alarm
 * mail would carry it (the token exists only in the mail otherwise).
 */
const SMARTEX_DM = '9001';
const ALARM = 1; // ProgeoAccess.NotifiTypes.ALARM

test.use({ storageState: roleState('subscriber') });

const alarmPill = (page: Page, userId: number) =>
  page.getByTestId('rechte-type').and(page.locator(`[data-test-key="${userId}-${ALARM}"]`));

const openOwnSettings = async (page: Page, location: number, userId: number) => {
  await openPage(page, `/location/${location}/permissions`, 'page-location-rechte');
  await expect(page.getByTestId('rechte-member').and(page.locator(`[data-test-key="${userId}"]`))).toBeVisible();
  return alarmPill(page, userId);
};

const alarmBitOnServer = async (
  request: Parameters<typeof apiCall>[0],
  baseURL: string | undefined,
  location: number,
  userId: number,
) => {
  const response = await apiCall(request, baseURL, 'GET', `/v1/location/${location}/access/`, STAFF_STATE);
  expect(response.status()).toBe(200);
  const members: Array<{ user_id: number; rule?: { type?: number } | null }> = (await response.json()).members || [];
  const member = members.find((entry) => entry.user_id === userId);
  return Boolean((Number(member?.rule?.type) || 0) & ALARM);
};

test('unsubscribe via the mail link', async ({ page, browser, request, baseURL }) => {
  const info = e2eInfo();
  test.skip(!info || !roleReady('subscriber'), 'needs the subscriber test user (E2E_DEMO_PASSWORD, e2e/README.md)');
  const { locations, users } = info as E2EInfo;
  const location = locations[SMARTEX_DM];
  const userId = users.subscriber.id as number;
  test.skip(!location || !userId, 'demo location 9001 or the subscriber missing - run demo_account on the server');

  // Before: subscribed to alarms (a run that stopped halfway left it off - switch it on).
  let pill = await openOwnSettings(page, location, userId);
  if ((await pill.getAttribute('aria-pressed')) !== 'true') {
    await pill.click();
  }
  await expect(pill).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => alarmBitOnServer(request, baseURL, location, userId)).toBe(true);

  // The link of the mail.
  const made = await apiCall(request, baseURL, 'POST', '/v1/e2e/notification-link/', STAFF_STATE, {
    role: 'subscriber',
    location_id: location,
  });
  expect(made.status(), await made.text()).toBe(200);
  const link: string = (await made.json()).url;
  expect(link).toMatch(/^\/notification\/[^?]+\?action=unsubscribe$/);

  // Opened from the mail: no login.
  const mail = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const reader = await mail.newPage();
    await reader.goto(link);
    await expect(reader.getByTestId('page-notification-link')).toBeVisible();
    await expect(reader.getByTestId('notification-link-intro')).toBeVisible();
    await reader.getByTestId('notification-link-submit').click();
    await expect(reader.getByTestId('notification-link-done')).toBeVisible();
    await expect(reader.getByTestId('notification-link-error')).toHaveCount(0);

    // The same link again: already done, nothing to click.
    await reader.goto(link);
    await expect(reader.getByTestId('notification-link-intro')).toBeVisible();
    await expect(reader.getByTestId('notification-link-submit')).toHaveCount(0);
  } finally {
    await mail.close();
  }

  // After: off on the server and in the subscriber's own settings.
  expect(await alarmBitOnServer(request, baseURL, location, userId)).toBe(false);
  pill = await openOwnSettings(page, location, userId);
  await expect(pill).not.toHaveAttribute('aria-pressed', 'true');

  // Subscribing again restores the start.
  await pill.click();
  await expect(pill).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => alarmBitOnServer(request, baseURL, location, userId)).toBe(true);
});
