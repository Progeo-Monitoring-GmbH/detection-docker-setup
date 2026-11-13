import { expect, locationId, openPage, test } from './fixtures';

/**
 * Smoke test: the main pages open (their root test id shows) and keep the
 * test id rule (src/testIds.ts). A starting point for real UI tests.
 */
const PAGES: Array<[path: string, pageTestId: string]> = [
  ['/location/overview/', 'page-location-overview'],
  ['/alarms/', 'page-alarms'],
  ['/map/', 'page-locations-map'],
];

for (const [path, pageTestId] of PAGES) {
  test(`${path} opens`, async ({ page, expectUniqueTestIds }) => {
    await openPage(page, path, pageTestId);
    await expectUniqueTestIds();
  });
}

const LOCATION_TABS: Array<[tab: string, pageTestId: string]> = [
  ['status', 'page-location-status'],
  ['analyse', 'page-location-analyse'],
  ['objekt', 'page-location-objekt'],
];

for (const [tab, pageTestId] of LOCATION_TABS) {
  test(`location ${tab} opens`, async ({ page, expectUniqueTestIds }) => {
    test.skip(!locationId, 'Set E2E_LOCATION_ID to test the location pages');
    await openPage(page, `/location/${locationId}/${tab}`, pageTestId);
    await expectUniqueTestIds();
  });
}

test('the analyse heatmap switches the Lageplan with the keys', async ({ page }) => {
  test.skip(!locationId, 'Set E2E_LOCATION_ID to test the location pages');
  await openPage(page, `/location/${locationId}/analyse`, 'page-location-analyse');
  const plans = page.getByTestId('analyse-heatmap-plans-option');
  test.skip((await plans.count()) < 2, 'The location has only one Lageplan');

  await page.keyboard.press('2');
  await expect(plans.nth(1)).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('1');
  await expect(plans.nth(0)).toHaveAttribute('aria-pressed', 'true');
});
