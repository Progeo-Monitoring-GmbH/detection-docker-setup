import type { Locator, Page } from '@playwright/test';
import { expect, expectConfirmGuard, locationId, openPage, test, type GuardedRequest } from './fixtures';

/**
 * The rule "every destructive action asks first" in the location / device
 * area: each trigger opens a confirmation that explains the consequences,
 * and nothing is sent before it is confirmed (expectConfirmGuard blocks the
 * action's requests with 418 - the tests run against staging, the confirm
 * button is never clicked).
 *
 * Needs E2E_LOCATION_ID (a demo-account location the staff test user sees).
 * A test skips when its trigger is not there (no rows, no plan, no
 * permission) - the data decides what can be checked.
 */

/** Whether `locator` shows up within `timeout` (data loads after the page root). */
const present = async (locator: Locator, timeout = 10_000) => {
  try {
    await locator.first().waitFor({ state: 'visible', timeout });
    return true;
  } catch {
    return false;
  }
};

/** The first enabled copy of a repeated button. */
const firstEnabled = (page: Page, testId: string) =>
  page.getByTestId(testId).and(page.locator(':enabled')).first();

/** Answers the next file chooser with a small in-memory file (instead of the OS dialog). */
const answerFileChooser = (page: Page, name: string, mimeType: string, content: string) => {
  page.once('filechooser', (chooser) => {
    void chooser.setFiles({ name, mimeType, buffer: Buffer.from(content) });
  });
};

const needsLocation = () => test.skip(!locationId, 'Set E2E_LOCATION_ID to test the location pages');

const ACCESS_DELETE: GuardedRequest[] = [{ url: /\/v1\/location\/\d+\/access\/delete\// }];
/** Removing a Lageplan (with its points). */
const DELETE_LAGEPLAN: GuardedRequest[] = [{ url: '/v1/status/measure_points/delete_lageplan/' }];
/** Replacing every point of the location (POST measure_points/ itself - an empty list clears them). */
const REPLACE_POINTS: GuardedRequest[] = [{ url: /\/v1\/status\/measure_points\/(\?|$)/ }];
const ACKNOWLEDGE: GuardedRequest[] = [{ url: /\/v1\/alarm\/\d+\/acknowledge\// }];
/** A small measurement export ({"data": [...]}, see measurements/export). */
const MEASUREMENTS_JSON = JSON.stringify({ models: ['ProgeoMeasurement'], count: 0, data: [] });

/**
 * Opens the first row of a repeated toggle whose `action` (same data-test-key)
 * is enabled once expanded - returns that action or null.
 */
const expandUntilEnabled = async (page: Page, toggleId: string, actionId: string) => {
  const toggles = page.getByTestId(toggleId);
  const count = await toggles.count();
  for (let index = 0; index < count; index += 1) {
    const toggle = toggles.nth(index);
    const key = await toggle.getAttribute('data-test-key');
    await toggle.click();
    const action = page.getByTestId(actionId).and(page.locator(`[data-test-key="${key}"]`));
    if ((await action.isVisible()) && (await action.isEnabled())) {
      return action;
    }
  }
  return null;
};

// ------------------------------------------------------------- location pages

test.describe('location pages', () => {
  test.beforeEach(needsLocation);

  test('dissolving a merged project asks first (#10)', async ({ page }) => {
    await openPage(page, `/location/${locationId}/status`, 'page-location-status');
    const trigger = page.getByTestId('location-group-dissolve');
    test.skip(!(await present(trigger, 5_000)), 'The location is not part of a merged project');
    await expectConfirmGuard(page, {
      trigger,
      dialog: 'location-group-dissolve-dialog',
      guarded: [{ url: '/v1/location-selection/dissolve/' }],
    });
  });

  test('revoking access on the permissions tab asks first (#11)', async ({ page }) => {
    await openPage(page, `/location/${locationId}/permissions`, 'page-location-rechte');
    const trigger = firstEnabled(page, 'rechte-revoke');
    test.skip(!(await present(trigger)), 'Nobody whose access may be revoked');
    await expectConfirmGuard(page, { trigger, dialog: 'rechte-revoke-dialog', guarded: ACCESS_DELETE });
  });

  test('removing an Objektleitung on the settings tab asks first (#38)', async ({ page }) => {
    await openPage(page, `/location/${locationId}/settings`, 'page-location-einstellungen');
    const trigger = page.getByTestId('einstell-staff-remove').first();
    test.skip(!(await present(trigger)), 'No Objektleitung assigned (or no right to remove one)');
    await expectConfirmGuard(page, { trigger, dialog: 'einstell-staff-remove-dialog', guarded: ACCESS_DELETE });
  });

  test('acknowledging the alarms of a Verdachtsstelle asks first (#51)', async ({ page }) => {
    await openPage(page, `/location/${locationId}/status`, 'page-location-status');
    test.skip(!(await present(page.getByTestId('verdachtsstelle-toggle'))), 'No Verdachtsstellen');
    const trigger = await expandUntilEnabled(page, 'verdachtsstelle-toggle', 'verdachtsstelle-acknowledge');
    test.skip(!trigger, 'No Verdachtsstelle with pending alarms');
    await expectConfirmGuard(page, {
      trigger: trigger!,
      dialog: 'verdachtsstelle-acknowledge-dialog',
      guarded: ACKNOWLEDGE,
    });
  });

  test('acknowledging the alarms of a computed suspicion point asks first (#51)', async ({ page }) => {
    await openPage(page, `/location/${locationId}/status`, 'page-location-status');
    test.skip(!(await present(page.getByTestId('computed-suspicion-toggle'))), 'No computed suspicion points');
    const trigger = await expandUntilEnabled(page, 'computed-suspicion-toggle', 'computed-suspicion-acknowledge');
    test.skip(!trigger, 'No suspicion point with pending alarms');
    await expectConfirmGuard(page, {
      trigger: trigger!,
      dialog: 'computed-suspicion-acknowledge-dialog',
      guarded: ACKNOWLEDGE,
    });
  });

  test('deleting all measurements (climate panels) asks first (#16)', async ({ page }) => {
    await openPage(page, `/location/${locationId}/analysis`, 'page-location-analyse');
    const trigger = page.getByTestId(/^(analyse-)?climate-panels-clean$/);
    test.skip(!(await present(trigger)), 'No climate panels (LoRaWAN only) or not a superuser');
    const dialog = (await trigger.first().getAttribute('data-testid'))!.replace(/-clean$/, '-clean-dialog');
    await expectConfirmGuard(page, {
      trigger: trigger.first(),
      dialog,
      guarded: [{ url: /\/v1\/location\/\d+\/measurements\/clean\// }],
    });
  });

  test('importing measurements (climate panels) asks before the upload (#45)', async ({ page }) => {
    await openPage(page, `/location/${locationId}/analysis`, 'page-location-analyse');
    const trigger = page.getByTestId(/^(analyse-)?climate-panels-import$/);
    test.skip(!(await present(trigger)), 'No climate panels (LoRaWAN only) or not a superuser');
    const dialog = (await trigger.first().getAttribute('data-testid'))!.replace(/-import$/, '-import-dialog');
    answerFileChooser(page, 'measurements.json', 'application/json', MEASUREMENTS_JSON);
    await expectConfirmGuard(page, {
      trigger: trigger.first(),
      dialog,
      guarded: [{ url: /\/v1\/location\/\d+\/measurements\/import\// }],
    });
  });

  test('deleting a noise profile asks first (#27)', async ({ page }) => {
    await openPage(page, `/location/${locationId}/analysis`, 'page-location-analyse');
    const toggle = page.getByTestId('noise-profile-toggle');
    test.skip(!(await present(toggle)), 'No noise profiles here (staff, not LoRaWAN)');
    await toggle.click();
    const select = page.getByTestId('noise-profile-select');
    test.skip((await select.locator('option').count()) < 2, 'The shown device has no noise profile');
    if (!(await page.getByTestId('noise-profile-delete').isVisible())) {
      await select.selectOption({ index: 1 });
    }
    await expectConfirmGuard(page, {
      trigger: page.getByTestId('noise-profile-delete'),
      dialog: 'noise-profile-delete-dialog',
      guarded: [{ url: /\/v1\/location\/\d+\/noise-profiles\/delete\// }],
    });
  });

  test('archiving the measurements of a span asks first (#30)', async ({ page }) => {
    await openPage(page, `/location/${locationId}/analysis`, 'page-location-analyse');
    const toggle = page.getByTestId('noise-profile-toggle');
    test.skip(!(await present(toggle)), 'No archive here (staff, not LoRaWAN)');
    await toggle.click();
    // The span to archive: the last 7 days.
    await page.getByTestId('noise-profile-range-last-7').click();
    const trigger = page.getByTestId('analyse-archive');
    await expect(trigger).toBeEnabled();
    await expectConfirmGuard(page, {
      trigger,
      dialog: 'analyse-archive-dialog',
      // Only the POST archives - the dialog's GET counts the measurements.
      guarded: [{ url: /\/v1\/location\/\d+\/measurements\/archive\// }],
    });
  });

  test('switching sensors off asks first (#12)', async ({ page }) => {
    await openPage(page, `/location/${locationId}/analysis`, 'page-location-analyse');
    const trigger = page.getByTestId('analyse-sensor-disable');
    test.skip(!(await present(trigger, 5_000)), 'No sensor selected (picked on the plan or in the charts)');
    await expectConfirmGuard(page, {
      trigger,
      dialog: 'analyse-sensor-disable-dialog',
      guarded: [{ url: /\/v1\/location\/\d+\/measurepoints\// }],
    });
  });
});

// ------------------------------------------------------------- devices

test.describe('devices', () => {
  test.beforeEach(needsLocation);

  test('deleting a device asks first (#4)', async ({ page }) => {
    await openPage(page, `/device/overview?location=${locationId}`, 'page-device-overview');
    const trigger = page.getByTestId('device-list-delete').first();
    test.skip(!(await present(trigger)), 'No device (or no right to delete one)');
    await expectConfirmGuard(page, {
      trigger,
      dialog: 'device-list-delete-confirm',
      guarded: [{ url: /\/v1\/device\/\d+\/delete\// }],
    });
  });

  test('deleting selected devices / locations asks first (#5)', async ({ page }) => {
    await openPage(page, '/device/statistics/', 'page-device-statistics');
    const checkbox = page.getByTestId('page-device-statistics').locator('input[name^="select-row-"]').first();
    test.skip(!(await present(checkbox)), 'No rows to select');
    await checkbox.check();
    await expectConfirmGuard(page, {
      trigger: page.getByTestId('device-stats-delete-selected'),
      dialog: 'device-stats-delete-confirm',
      guarded: [{ url: '/v1/status/device_statistics/delete/' }],
    });
  });
});

// ------------------------------------------------------------- Lageplan wizard

test.describe('Lageplan wizard', () => {
  test.beforeEach(needsLocation);

  const openWizard = (page: Page) =>
    openPage(page, `/site-plan/wizard/?location=${locationId}`, 'page-lageplan-wizard');

  test('removing a Lageplan asks first (#8)', async ({ page }) => {
    await openWizard(page);
    const trigger = firstEnabled(page, 'lageplan-tile-remove');
    test.skip(!(await present(trigger)), 'The location has no Lageplan');
    await expectConfirmGuard(page, { trigger, dialog: 'lageplan-wizard-confirm', guarded: DELETE_LAGEPLAN });
  });

  test('clearing the measure points asks first (#9)', async ({ page }) => {
    await openWizard(page);
    const trigger = page.getByTestId('lageplan-wizard-points-clear');
    test.skip(!(await present(trigger)), 'The location has no measure points');
    await expectConfirmGuard(page, { trigger, dialog: 'lageplan-wizard-confirm', guarded: REPLACE_POINTS });
  });

  test('a CAD import that replaces the points asks before the upload (#47)', async ({ page }) => {
    await openWizard(page);
    const trigger = page.getByTestId('lageplan-wizard-import-cad');
    test.skip(!(await present(trigger)), 'No CAD import offered (device ranges to fix first?)');
    answerFileChooser(page, 'e2e-points.dxf', 'application/dxf', '0\nEOF\n');
    await expectConfirmGuard(page, {
      trigger,
      dialog: 'lageplan-wizard-import-dialog',
      guarded: [{ url: '/v1/status/measure_points/upload_cad/' }],
    });
  });

  test('deleting a heat limitation asks first (#26)', async ({ page }) => {
    await openWizard(page);
    const trigger = page.getByTestId('heat-limit-stage-heat-limit-delete').first();
    test.skip(!(await present(trigger)), 'No heat limitation on the shown Lageplan');
    await expectConfirmGuard(page, {
      trigger,
      dialog: 'heat-limit-stage-heat-limit-delete-dialog',
      guarded: [{ url: /\/v1\/location\/\d+\/heat-limitations\/delete\// }],
    });
  });
});

// ------------------------------------------------------------- management pages

test.describe('management', () => {
  test('revoking a permission in the object management asks first (#39)', async ({ page }) => {
    needsLocation();
    await openPage(page, '/management/', 'page-verwaltung');
    const open = page.getByTestId('verwaltung-row-permissions').and(page.locator(`[data-test-key$="-${locationId}"]`));
    test.skip(!(await present(open)), 'The location is not listed on the first page');
    await open.first().click();
    const trigger = page.getByTestId('verwaltung-permissions-revoke').first();
    test.skip(!(await present(trigger)), 'Nobody has a permission rule on the location');
    await expectConfirmGuard(page, {
      trigger,
      dialog: 'verwaltung-permissions-revoke-dialog',
      guarded: ACCESS_DELETE,
    });
  });

  test('importing data on "create object" asks before the upload (#46)', async ({ page }) => {
    await openPage(page, '/create/', 'page-anlegen');
    answerFileChooser(page, 'e2e-import.json', 'application/json', MEASUREMENTS_JSON);
    await expectConfirmGuard(page, {
      trigger: page.getByTestId('anlegen-import'),
      dialog: 'anlegen-import-dialog',
      guarded: [{ url: '/v1/data/import/' }],
    });
  });
});
