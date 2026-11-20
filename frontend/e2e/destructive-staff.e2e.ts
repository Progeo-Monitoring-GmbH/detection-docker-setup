import type { Locator, Page } from '@playwright/test';
import { blockDestructive, expect, expectConfirmGuard, test, type GuardedRequest } from './fixtures';
import { e2eInfo } from './roles';

/**
 * The rule "every destructive action asks first" in the staff area: each
 * test opens a page as the staff user (E2E_USERNAME), clicks a destructive
 * button and checks with expectConfirmGuard() that a ConfirmDialog explains
 * the consequences and that nothing reaches the server - every endpoint the
 * action could call is in `guarded` (answered with 418 in the browser).
 * The confirm button is never clicked: these tests run against staging and
 * its real data. Without a row to act on (no backups, no pending command,
 * ...) or without the permission for the button, a test skips.
 * Where there is a choice, the rows of the demo account are taken.
 */

// ------------------------------------------------------------------ helpers

/** Opens `path`; skips the test when its page doesn't show (no permission for it). */
const openOrSkip = async (page: Page, path: string, pageTestId: string) => {
  await page.goto(path);
  const shown = await page
    .getByTestId(pageTestId)
    .first()
    .waitFor({ state: 'visible', timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  test.skip(!shown, `${path}: the staff user doesn't see ${pageTestId}`);
};

/** The first visible, enabled of `locator` - or skips the test with `reason`. */
const firstOrSkip = async (locator: Locator, reason: string) => {
  const usable = locator.and(locator.page().locator(':enabled')).first();
  const found = await usable
    .waitFor({ state: 'visible', timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  test.skip(!found, reason);
  return usable;
};

/** Waits until `loaded` (rows) or `empty` shows - the list answered. */
const waitForList = async (loaded: Locator, empty: Locator) => {
  await expect(loaded.first().or(empty.first())).toBeVisible({ timeout: 20_000 });
};

/** The project ids of the demo account's locations ("9001", ...); [] without e2e-info. */
const demoProjects = () => Object.keys(e2eInfo()?.locations ?? {});
/** A demo user's email (customer, else any role) for the staff user filter. */
const demoUserEmail = () => {
  const users = e2eInfo()?.users;
  return users?.customer?.email || users?.single?.email || users?.subscriber?.email || null;
};

// ------------------------------------------------------------------ backups

const BACKUP_GUARD: GuardedRequest[] = [{ url: /\/backup\/(\d+\/(restore|delete|sanitize)|deleteAll)\// }];

/** The backup list, of a demo project when it has backups. */
const openBackups = async (page: Page) => {
  const rows = page.getByTestId('backup-restore');
  for (const project of demoProjects().slice(0, 1)) {
    await openOrSkip(page, `/backup/1/overview/?project=${project}`, 'page-backup');
    await waitForList(rows, page.getByTestId('backup-empty'));
    if (await rows.count()) {
      return;
    }
  }
  await openOrSkip(page, '/backup/1/overview/', 'page-backup');
  await waitForList(rows, page.getByTestId('backup-empty'));
};

test.describe('backups', () => {
  test('restoring a backup asks first (it overwrites the database)', async ({ page }) => {
    await openBackups(page);
    const trigger = await firstOrSkip(page.getByTestId('backup-restore'), 'no backups listed');
    await expectConfirmGuard(page, { trigger, dialog: 'backup-restore-dialog', guarded: BACKUP_GUARD });
  });

  test('deleting one backup asks first', async ({ page }) => {
    await openBackups(page);
    const trigger = await firstOrSkip(page.getByTestId('backup-delete'), 'no backups, or no module_backup_delete');
    await expectConfirmGuard(page, { trigger, dialog: 'backup-delete-dialog', guarded: BACKUP_GUARD });
  });

  test('deleting the shown backups asks first', async ({ page }) => {
    await openBackups(page);
    test.skip((await page.getByTestId('backup-restore').count()) === 0, 'no backups listed');
    const trigger = await firstOrSkip(page.getByTestId('backup-delete-bulk'), 'no module_backup_delete');
    await expectConfirmGuard(page, { trigger, dialog: 'backup-delete-confirm', guarded: BACKUP_GUARD });
  });
});

// ------------------------------------------------------------------ docker

const DOCKER_GUARD: GuardedRequest[] = [{ url: /\/api\/docker\/(start|stop|restart|remove)\// }];

const openDocker = async (page: Page) => {
  await openOrSkip(page, '/developer/docker/', 'page-docker');
  await waitForList(page.getByTestId('docker-container-name'), page.getByTestId('docker-empty').or(page.getByTestId('docker-error')));
};

test.describe('docker', () => {
  test('stopping a running container asks first', async ({ page }) => {
    await openDocker(page);
    const running = page.getByTestId('docker-container-status').filter({ hasText: /^running$/ });
    test.skip((await running.count()) === 0, 'no running container');
    const key = await running.first().getAttribute('data-test-key');
    const trigger = page.getByTestId('docker-container-start-stop').and(page.locator(`[data-test-key="${key}"]`));
    await expectConfirmGuard(page, { trigger, dialog: 'docker-confirm', guarded: DOCKER_GUARD });
  });

  test('restarting a container asks first', async ({ page }) => {
    await openDocker(page);
    const trigger = await firstOrSkip(page.getByTestId('docker-container-restart'), 'no containers');
    await expectConfirmGuard(page, { trigger, dialog: 'docker-confirm', guarded: DOCKER_GUARD });
  });

  test('removing a stopped container asks first', async ({ page }) => {
    await openDocker(page);
    const trigger = await firstOrSkip(page.getByTestId('docker-container-remove'), 'no stopped container');
    await expectConfirmGuard(page, { trigger, dialog: 'docker-confirm', guarded: DOCKER_GUARD });
  });
});

// ------------------------------------------------------------------ staff admin: users

const USER_GUARD: GuardedRequest[] = [
  { url: /\/api\/auth-support\/staff\/users\/\d+\/(update|password|delete|invite|impersonate)\// },
];

/** /staff/ with its user table loaded - narrowed to a demo user when there is one. */
const openUsers = async (page: Page) => {
  await openOrSkip(page, '/staff/', 'page-staff');
  test.skip(await page.getByTestId('staff-access-required').isVisible(), 'no user administration');
  await expect(page.getByTestId('staff-users-loading')).toBeHidden({ timeout: 20_000 });
  const email = demoUserEmail();
  if (email) {
    await page.getByTestId('staff-users-filter-text').fill(email);
    if ((await page.getByTestId('staff-user-edit').count()) === 0) {
      await page.getByTestId('staff-users-filter-text').fill('');
    }
  }
};

test.describe('staff users', () => {
  test('generating a password asks first (the old one stops working)', async ({ page }) => {
    await openUsers(page);
    const trigger = await firstOrSkip(page.getByTestId('staff-user-generate-password'), 'no users, or not staff');
    await expectConfirmGuard(page, { trigger, dialog: 'staff-user-password-dialog', guarded: USER_GUARD });
  });

  test('generating a password in the edit dialog asks first', async ({ page }) => {
    await openUsers(page);
    await (await firstOrSkip(page.getByTestId('staff-user-edit'), 'no users')).click();
    await expect(page.getByTestId('staff-user-edit-dialog')).toBeVisible();
    const trigger = await firstOrSkip(
      page.getByTestId('staff-user-edit-dialog-generate-password'),
      'no password button (not staff)',
    );
    await expectConfirmGuard(page, { trigger, dialog: 'staff-user-password-dialog', guarded: USER_GUARD });
  });

  test('deactivating a user in the edit dialog asks on save', async ({ page }) => {
    await openUsers(page);
    // An active user: their "active" badge, then their edit button.
    const active = page.getByTestId('staff-user-active').and(page.locator('.bg-success'));
    test.skip((await active.count()) === 0, 'no active user');
    const key = await active.first().getAttribute('data-test-key');
    await page.getByTestId('staff-user-edit').and(page.locator(`[data-test-key="${key}"]`)).click();
    const dialog = page.getByTestId('staff-user-edit-dialog');
    await expect(dialog).toBeVisible();
    const activeSwitch = page.getByTestId('staff-user-edit-dialog-is-active');
    test.skip((await activeSwitch.count()) === 0, 'no module_user_disability');
    await activeSwitch.uncheck();
    await expectConfirmGuard(page, {
      trigger: page.getByTestId('staff-user-edit-dialog-save'),
      dialog: 'staff-user-deactivate-dialog',
      guarded: USER_GUARD,
    });
  });

  test('sending an invitation asks first', async ({ page }) => {
    await openUsers(page);
    const trigger = await firstOrSkip(page.getByTestId('staff-user-invite'), 'no invitable user, or no module_user_invitable');
    await expectConfirmGuard(page, { trigger, dialog: 'staff-user-invite-dialog', guarded: USER_GUARD });
  });

  test('resetting 2FA asks first', async ({ page }) => {
    await openUsers(page);
    if ((await page.getByTestId('staff-user-reset-two-factor').count()) === 0) {
      // Only users with 2FA have the button.
      await page.getByTestId('staff-users-filter-text').fill('');
      await page.getByTestId('staff-users-filter-two-factor').selectOption('on');
    }
    const trigger = await firstOrSkip(page.getByTestId('staff-user-reset-two-factor'), 'no user with 2FA');
    await expectConfirmGuard(page, { trigger, dialog: 'staff-user-reset-two-factor-dialog', guarded: USER_GUARD });
  });

  test('logging in as a user asks first', async ({ page }) => {
    await openUsers(page);
    const trigger = await firstOrSkip(page.getByTestId('staff-user-impersonate'), 'superusers only');
    await expectConfirmGuard(page, { trigger, dialog: 'staff-user-impersonate-dialog', guarded: USER_GUARD });
  });

  test('deleting a user asks first', async ({ page }) => {
    await openUsers(page);
    const trigger = await firstOrSkip(page.getByTestId('staff-user-delete'), 'no module_user_erasability');
    await expectConfirmGuard(page, { trigger, dialog: 'staff-user-delete-dialog', guarded: USER_GUARD });
  });
});

// ------------------------------------------------------------------ staff admin: the other panels

test.describe('staff panels', () => {
  test('rejecting an access request asks first', async ({ page }) => {
    await openOrSkip(page, '/staff/', 'staff-requests');
    const trigger = await firstOrSkip(page.getByTestId('staff-requests-reject'), 'no pending access request');
    // The decision modal (with a note) is the confirmation - "-submit", not "-confirm".
    const sent = await blockDestructive(page, [
      { url: /\/api\/auth-support\/staff\/access-requests\/\d+\/(reject|approve)\// },
    ]);
    await trigger.click();
    const box = page.getByTestId('staff-requests-decision');
    await expect(box).toBeVisible();
    await expect(page.getByTestId('staff-requests-decision-submit')).toBeVisible();
    expect((await box.innerText()).trim().length).toBeGreaterThanOrEqual(25);
    expect(sent).toHaveLength(0);
    await page.getByTestId('staff-requests-decision-cancel').click();
    await expect(box).toBeHidden();
    await page.waitForTimeout(300);
    expect(sent).toHaveLength(0);
  });

  test('releasing the mail emergency brake asks first', async ({ page }) => {
    await openOrSkip(page, '/staff/', 'staff-messaging');
    const trigger = await firstOrSkip(page.getByTestId('staff-messaging-breaker-reset'), 'the brake is not tripped');
    await expectConfirmGuard(page, {
      trigger,
      dialog: 'staff-messaging-breaker-reset-dialog',
      guarded: [{ url: '/api/auth-support/staff/messaging/breaker/reset/' }],
    });
  });

  test('removing a mail block asks first', async ({ page }) => {
    await openOrSkip(page, '/staff/', 'staff-messaging');
    const trigger = await firstOrSkip(page.getByTestId('staff-messaging-suppression-delete'), 'no blocked address');
    await expectConfirmGuard(page, {
      trigger,
      dialog: 'staff-messaging-suppression-delete-dialog',
      guarded: [{ url: /\/api\/auth-support\/staff\/messaging\/suppressions\/\d+\/delete\// }],
    });
  });

  test('closing a notification case asks first', async ({ page }) => {
    await openOrSkip(page, '/staff/', 'staff-notifications');
    const rows = page.getByTestId('staff-notifications').locator('.rdt_TableRow');
    const found = await rows
      .first()
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    test.skip(!found, 'no open notification case');
    // A case of a demo location if there is one.
    const demo = demoProjects().length
      ? rows.filter({ hasText: new RegExp(`\\b(${demoProjects().join('|')})\\b`) })
      : rows;
    // DataTable opens a row on a click on a plain cell (data-tag="allowRowEvents"), not on a badge or link.
    const row = ((await demo.count()) ? demo : rows).first();
    await row.locator('[data-tag="allowRowEvents"]').last().click();
    await expect(page.getByTestId('staff-notifications-detail')).toBeVisible();
    const trigger = await firstOrSkip(page.getByTestId('staff-notifications-close'), 'the case is not open');
    await expectConfirmGuard(page, {
      trigger,
      dialog: 'staff-notifications-close-dialog',
      guarded: [{ url: /\/v1\/notification-case\/\d+\/(close|mute|unmute)\// }],
    });
  });
});

// ------------------------------------------------------------------ escalations

test('closing an escalation asks first', async ({ page }) => {
  await openOrSkip(page, '/escalations/', 'page-escalations');
  const items = page.getByTestId('escalations-item');
  await waitForList(items, page.getByTestId('escalations-list-empty'));
  test.skip((await items.count()) === 0, 'no open escalation');
  const demo = demoProjects().length ? items.filter({ hasText: new RegExp(`\\b(${demoProjects().join('|')})\\b`) }) : items;
  await ((await demo.count()) ? demo : items).first().click();
  const trigger = await firstOrSkip(page.getByTestId('escalation-close'), 'the escalation is closed');
  await expectConfirmGuard(page, {
    trigger,
    dialog: 'escalation-close-dialog',
    guarded: [{ url: /\/v1\/escalation\/\d+\/(close|status|assign|comment)\// }],
  });
});

// ------------------------------------------------------------------ screen review

const SCREENS_GUARD: GuardedRequest[] = [{ method: 'DELETE', url: '/v1/screen-review/' }];

test.describe('screen review', () => {
  test('deleting a run asks first', async ({ page }) => {
    await openOrSkip(page, '/review/screens/', 'page-screen-review');
    const trigger = await firstOrSkip(page.getByTestId('screens-delete-run'), 'no run, or not a superuser');
    await expectConfirmGuard(page, { trigger, dialog: 'screens-delete-confirm', guarded: SCREENS_GUARD });
  });

  test('deleting a comment asks first', async ({ page }) => {
    await openOrSkip(page, '/review/screens/', 'page-screen-review');
    await waitForList(page.getByTestId('screens-commented-only'), page.getByTestId('screens-no-runs'));
    test.skip(await page.getByTestId('screens-no-runs').isVisible(), 'no screenshot run');
    await page.getByTestId('screens-commented-only').check();
    const open = await firstOrSkip(page.getByTestId('screen-card-open'), 'no commented screenshot');
    await open.click();
    await expect(page.getByTestId('screen-editor')).toBeVisible();
    const trigger = await firstOrSkip(page.getByTestId('screen-note-delete'), 'no comment');
    await expectConfirmGuard(page, { trigger, dialog: 'screen-note-delete-dialog', guarded: SCREENS_GUARD });
  });
});

// ------------------------------------------------------------------ controller commands

const COMMANDS_GUARD: GuardedRequest[] = [
  { url: /\/v1\/device\/\d+\/commands\/(queue|\d+\/cancel)\// },
  { url: /\/v1\/device\/\d+\/firmware\/update\// },
];

/** The commands dialog of a controller - a demo one (project 9001, ...) when listed. */
const openCommands = async (page: Page) => {
  await openOrSkip(page, '/device/overview', 'page-device-overview');
  const buttons = page.getByTestId('device-list-commands').and(page.locator(':enabled'));
  await expect(page.getByTestId('device-list-table')).toBeVisible({ timeout: 20_000 });
  const [project] = demoProjects();
  if (project) {
    await page.getByTestId('device-list-table-search').fill(`${project}-`);
    if ((await buttons.count()) === 0) {
      await page.getByTestId('device-list-table-search').fill('');
    }
  }
  const button = await firstOrSkip(page.getByTestId('device-list-commands'), 'no controller with commands');
  await button.click();
  await expect(page.getByTestId('device-commands')).toBeVisible();
  await expect(page.getByTestId('device-commands-loading')).toBeHidden({ timeout: 15_000 });
};

const commandButton = (page: Page, command: string) =>
  page.getByTestId('device-commands-command').and(page.locator(`[data-test-key="${command}"]`));

test.describe('controller commands', () => {
  test('restarting a controller asks first', async ({ page }) => {
    await openCommands(page);
    const trigger = await firstOrSkip(commandButton(page, 'restart'), 'restart not offered');
    await expectConfirmGuard(page, { trigger, dialog: 'device-commands-restart-dialog', guarded: COMMANDS_GUARD });
  });

  test('maintenance mode asks first', async ({ page }) => {
    await openCommands(page);
    const trigger = await firstOrSkip(commandButton(page, 'maintenance'), 'maintenance not offered');
    await expectConfirmGuard(page, { trigger, dialog: 'device-commands-maintenance-dialog', guarded: COMMANDS_GUARD });
  });

  test('sending parameters asks first', async ({ page }) => {
    await openCommands(page);
    const trigger = await firstOrSkip(page.getByTestId('device-commands-send-params'), 'set_params not offered');
    await expectConfirmGuard(page, { trigger, dialog: 'device-commands-send-params-dialog', guarded: COMMANDS_GUARD });
  });

  test('sending a file asks first', async ({ page }) => {
    await openCommands(page);
    const content = page.getByTestId('device-commands-update-content');
    test.skip((await content.count()) === 0, 'update: superusers only');
    await content.fill('-- e2e: never sent');
    const trigger = await firstOrSkip(page.getByTestId('device-commands-send-update'), 'update not offered');
    await expectConfirmGuard(page, { trigger, dialog: 'device-commands-send-update-dialog', guarded: COMMANDS_GUARD });
  });

  test('cancelling a queued command asks first', async ({ page }) => {
    await openCommands(page);
    const trigger = await firstOrSkip(page.getByTestId('device-commands-cancel'), 'no pending command');
    await expectConfirmGuard(page, { trigger, dialog: 'device-commands-cancel-command-dialog', guarded: COMMANDS_GUARD });
  });

  test('a firmware update asks first', async ({ page }) => {
    await openCommands(page);
    const trigger = await firstOrSkip(page.getByTestId('device-commands-firmware-start'), 'no remote firmware update');
    await expectConfirmGuard(page, { trigger, dialog: 'device-commands-firmware-start-dialog', guarded: COMMANDS_GUARD });
  });
});
