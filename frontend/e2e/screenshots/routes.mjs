// The screens the e2e_screenshots command captures (capture.mjs): every route
// of the app with the parameters that show something, who sees it, and the
// dialogs that open on it.
//
//   action  - the file name's last part: {pc|mobile}-{user|staff}-{de|en}-{action}.png
//   path    - opened as is (the mocked location is #1, escalation #1)
//   roles   - "user": a customer with the usual module permissions,
//             "staff": staff (and superuser - every page) - see mockApi.mjs
//   public  - opened without a login (captured once, as "user")
//   modals  - the dialogs (Modal, ConfirmDialog, drawers) opened on this page,
//             each its own screenshot {...}-{action}--{name}.png, taken from a
//             freshly loaded page:
//
//     testId    data-testid of the dialog - waited for, then the window is shot
//     open      the steps that open it, in order. A step is a test id (a click)
//               or an object with one verb - its value a test id, or { css }
//               for an element without one:
//                 { click | check | uncheck | hover: 'test-id', key? }
//                 { fill | select: 'test-id', key?, value }
//                 { upload: 'test-id', file: { name, content, mimeType? } }
//                 { press: 'Escape' }   { wait: 500 }
//               `key` is the element's data-test-key (repeated elements);
//               `device: 'mobile' | 'pc'` - a step on that device only (e.g. a
//               phone table's row expander).
//     name      the file name's dialog part (a-z, 0-9, -) - default: testId
//     roles     fewer than the page's (default: the page's)
//     devices   only these (default: all)
//     path      opened on another URL (default: the page's)
//     scenario  a variant of the mocked data (mockApi.mjs SCENARIOS)
//
//   A new ConfirmDialog is one line in its page's modals:
//     { testId: 'backup-delete-confirm', open: ['backup-delete-bulk'] },

/** A phone table's row expander (DataTable's own, around the row's other columns). */
const expandRow = (key) => ({
  click: { css: `#row-${key} [data-testid^="expander-button-"]` },
  device: 'mobile',
});
/** A row's selection checkbox (SearchableDataTable / selectionColumn) in the table `table`. */
const selectRow = (table, key) => ({
  check: { css: `[data-testid="${table}"] #row-${key} input.progeo-table-check` },
});
/** react-data-table's own selection checkbox of a row (selectableRows). */
const selectTableRow = (scope, key) => ({
  check: { css: `${scope} input[name="select-row-${key}"]` },
});

/** The profile drawer (top bar → account) - on every page after the login. */
const ACCOUNT_MODALS = [
  { testId: 'topbar-logout-dialog', open: ['topbar-logout'] },
  { testId: 'user-profile', open: ['topbar-account'] },
  {
    testId: 'user-profile-request-access-dialog',
    open: ['topbar-account', 'user-profile-request-access'],
  },
  {
    testId: 'user-profile-delete-account-dialog',
    open: ['topbar-account', 'user-profile-delete-account-button'],
  },
  {
    testId: 'user-profile-two-factor-dialog',
    open: ['topbar-account', 'user-profile-two-factor-open'],
  },
  {
    name: 'privacy-settings',
    testId: 'cookie-banner',
    open: ['topbar-info', 'topbar-privacy-settings'],
  },
  { testId: 'sidebar-menu', open: ['sidebar-burger'], devices: ['mobile'] },
];

const STAFF_USER_ROW = '2';

export const ROUTES = [
  // -- before the login -----------------------------------------------------------
  { action: 'login', path: '/login', roles: ['user'], public: true },
  { action: 'login-link', path: '/login/link', roles: ['user'], public: true },
  {
    action: 'forgot-password',
    path: '/forgot-password',
    roles: ['user'],
    public: true,
  },
  {
    action: 'access-request',
    path: '/access/request',
    roles: ['user'],
    public: true,
  },
  {
    action: 'privacy',
    path: '/privacy',
    roles: ['user'],
    public: true,
    modals: [
      {
        name: 'privacy-settings',
        testId: 'cookie-banner',
        open: ['privacy-policy-settings'],
      },
    ],
  },

  // -- the locations ----------------------------------------------------------------
  {
    action: 'location-overview',
    path: '/location/overview/',
    roles: ['user', 'staff'],
    modals: [
      ...ACCOUNT_MODALS,
      {
        testId: 'merge-projects-modal',
        roles: ['staff'],
        open: [
          selectRow('locations-table', 3),
          selectRow('locations-table', 4),
          'locations-selection-merge',
          // The "number is free" check waits for the typing to stop.
          { wait: 500 },
        ],
      },
      {
        testId: 'assign-locations-modal',
        roles: ['staff'],
        open: [selectRow('locations-table', 3), 'locations-selection-assign'],
      },
    ],
  },
  {
    action: 'location-status',
    path: '/location/1/status',
    roles: ['user', 'staff'],
    modals: [
      {
        testId: 'location-group-dissolve-dialog',
        open: ['location-group-dissolve'],
      },
      {
        // Location #3: no open escalation, the banner offers a new one.
        testId: 'escalation-create-dialog',
        roles: ['staff'],
        path: '/location/3/status',
        open: ['escalation-create'],
      },
    ],
  },
  {
    action: 'location-status-timeseries',
    path: '/location/1/status?view=zeitreihe&range=7d',
    roles: ['user', 'staff'],
  },
  {
    action: 'location-analysis',
    path: '/location/1/analysis',
    roles: ['staff'],
    modals: [
      {
        testId: 'analyse-archive-dialog',
        open: [
          'noise-profile-toggle',
          'noise-profile-range-last-7',
          'analyse-archive',
        ],
      },
      {
        testId: 'analyse-sensor-disable-dialog',
        open: [
          { click: 'measurement-compare-columns-column', key: '1' },
          'analyse-sensor-disable',
        ],
      },
      {
        testId: 'noise-profile-delete-dialog',
        open: [
          'noise-profile-toggle',
          { select: 'noise-profile-select', value: '5' },
          'noise-profile-delete',
        ],
      },
    ],
  },
  {
    action: 'location-object',
    path: '/location/1/object',
    roles: ['user', 'staff'],
  },
  {
    action: 'location-notifications',
    path: '/location/1/notifications',
    roles: ['user', 'staff'],
    modals: [
      {
        testId: 'matrix-setup',
        open: [
          { click: 'notification-channel-choice-option', key: 'matrix' },
          'notification-channel-save',
        ],
      },
      {
        testId: 'benach-test-dialog',
        roles: ['staff'],
        open: ['benach-test-button'],
      },
    ],
  },
  {
    action: 'location-permissions',
    path: '/location/1/permissions',
    roles: ['user', 'staff'],
    modals: [
      {
        testId: 'rechte-revoke-dialog',
        roles: ['staff'],
        open: [{ click: 'rechte-revoke', key: '7' }],
      },
    ],
  },
  {
    action: 'location-settings',
    path: '/location/1/settings',
    roles: ['staff'],
    modals: [
      {
        testId: 'einstell-staff-remove-dialog',
        open: [{ click: 'einstell-staff-remove', key: '11' }],
      },
    ],
  },

  // -- staff ------------------------------------------------------------------------
  {
    action: 'management',
    path: '/management/',
    roles: ['staff'],
    modals: [
      {
        testId: 'verwaltung-permissions-dialog',
        open: [
          expandRow('1-1'),
          { click: 'verwaltung-row-permissions', key: '1-1' },
        ],
      },
      {
        testId: 'verwaltung-permissions-revoke-dialog',
        open: [
          expandRow('1-1'),
          { click: 'verwaltung-row-permissions', key: '1-1' },
          { click: 'verwaltung-permissions-revoke', key: '12' },
        ],
      },
    ],
  },
  {
    action: 'create-location',
    path: '/create/',
    roles: ['staff'],
    modals: [
      {
        testId: 'anlegen-import-dialog',
        open: [
          {
            upload: 'anlegen-import-input',
            file: {
              name: 'standort-4741.json',
              content: JSON.stringify({
                data: [
                  { clazz: 'Location', id: 4741 },
                  { clazz: 'Device', id: 1 },
                  { clazz: 'Device', id: 2 },
                  { clazz: 'Lageplan', id: 1 },
                ],
              }),
            },
          },
        ],
      },
    ],
  },
  { action: 'checklist', path: '/checklist/location/', roles: ['staff'] },
  {
    action: 'checklist-location',
    path: '/checklist/location/?location=1',
    roles: ['staff'],
    modals: [
      {
        testId: 'checklist-airtable-confirm',
        open: [{ click: 'checklist-fix', key: 'airtable' }],
      },
    ],
  },
  { action: 'alarms', path: '/alarms/', roles: ['staff'] },
  { action: 'alarm-report', path: '/alarms/report/', roles: ['staff'] },
  { action: 'escalations', path: '/escalations/', roles: ['staff'] },
  {
    action: 'escalation-detail',
    path: '/escalations/1',
    roles: ['staff'],
    modals: [{ testId: 'escalation-close-dialog', open: ['escalation-close'] }],
  },
  {
    action: 'device-overview',
    path: '/device/overview?location=1',
    roles: ['staff'],
    modals: [
      {
        testId: 'device-list-delete-confirm',
        open: [expandRow(1), { click: 'device-list-delete', key: '1' }],
      },
      {
        testId: 'device-commands',
        open: [expandRow(1), { click: 'device-list-commands', key: '1' }],
      },
      {
        testId: 'provision-test-clear-dialog',
        open: [
          expandRow(1),
          { click: 'device-list-test-measurements', key: '1' },
          'provision-test-clear',
        ],
      },
    ],
  },
  {
    action: 'device-statistics',
    path: '/device/statistics/',
    roles: ['staff'],
    modals: [
      {
        testId: 'device-stats-delete-confirm',
        open: [
          selectTableRow(
            '[data-testid="device-stats-type-group"][data-test-key="smartbox"]',
            1,
          ),
          'device-stats-delete-selected',
        ],
      },
    ],
  },
  {
    action: 'site-plan-wizard',
    path: '/site-plan/wizard/?location=1',
    roles: ['staff'],
    modals: [
      {
        testId: 'lageplan-wizard-confirm',
        open: [{ click: 'lageplan-tile-remove', key: '100' }],
      },
      {
        testId: 'lageplan-wizard-rename',
        open: [{ click: 'lageplan-tile-rename', key: '100' }],
      },
    ],
  },
  { action: 'map', path: '/map/', roles: ['staff'] },
  {
    action: 'staff-admin',
    path: '/staff/',
    roles: ['staff'],
    modals: [
      { testId: 'staff-user-create', open: ['staff-users-add'] },
      {
        testId: 'staff-user-edit-dialog',
        open: [
          expandRow(STAFF_USER_ROW),
          { click: 'staff-user-edit', key: STAFF_USER_ROW },
        ],
      },
      {
        testId: 'staff-user-deactivate-dialog',
        open: [
          expandRow(STAFF_USER_ROW),
          { click: 'staff-user-edit', key: STAFF_USER_ROW },
          { uncheck: 'staff-user-edit-dialog-is-active' },
          'staff-user-edit-dialog-save',
        ],
      },
      ...['password', 'invite', 'reset-two-factor', 'impersonate', 'delete'].map(
        (kind) => ({
          testId: `staff-user-${kind}-dialog`,
          open: [
            expandRow(STAFF_USER_ROW),
            {
              click: kind === 'password' ? 'staff-user-generate-password' : `staff-user-${kind}`,
              key: STAFF_USER_ROW,
            },
          ],
        }),
      ),
      {
        testId: 'staff-password-result',
        open: [
          expandRow(STAFF_USER_ROW),
          { click: 'staff-user-generate-password', key: STAFF_USER_ROW },
          'staff-user-password-dialog-confirm',
        ],
      },
      {
        testId: 'staff-requests-decision',
        open: [{ click: 'staff-requests-approve', key: '1' }],
      },
      {
        testId: 'staff-messaging-breaker-reset-dialog',
        scenario: 'breaker-tripped',
        open: ['staff-messaging-breaker-reset'],
      },
      {
        testId: 'staff-messaging-suppression-delete-dialog',
        open: [{ click: 'staff-messaging-suppression-delete', key: '1' }],
      },
      {
        testId: 'staff-notifications-detail',
        open: [{ click: 'staff-notifications-kind', key: '1' }],
      },
      {
        testId: 'staff-notifications-close-dialog',
        open: [
          { click: 'staff-notifications-kind', key: '1' },
          'staff-notifications-close',
        ],
      },
    ],
  },
  {
    action: 'insights-databases',
    path: '/insights/databases/',
    roles: ['staff'],
    modals: [
      {
        testId: 'database-usage-ids-modal',
        open: [
          selectRow('database-usage-rows', 'progeo_4700'),
          'database-usage-show-ids',
        ],
      },
    ],
  },
  {
    action: 'insights-activity',
    path: '/insights/activity/',
    roles: ['staff'],
  },
  { action: 'interface', path: '/interface/', roles: ['staff'] },
  {
    action: 'backup',
    path: '/backup/1/overview/',
    roles: ['staff'],
    modals: [
      { testId: 'backup-delete-confirm', open: ['backup-delete-bulk'] },
    ],
  },
  { action: 'admin-panel', path: '/admin/panel/', roles: ['staff'] },
  {
    action: 'developer',
    path: '/developer',
    roles: ['staff'],
    modals: [
      {
        name: 'docker-restart',
        testId: 'docker-confirm',
        open: [{ click: 'docker-container-restart', key: 'a1b2c3d4e5f60001' }],
      },
      {
        testId: 'docker-logs-dialog',
        open: [{ click: 'docker-container-logs', key: 'a1b2c3d4e5f60001' }],
      },
    ],
  },
  {
    action: 'screen-review',
    path: '/review/screens/',
    roles: ['staff'],
    modals: [
      {
        testId: 'screen-editor',
        open: [{ click: 'screen-card-comment', key: 'pc-user-de-login.png' }],
      },
      { testId: 'screens-delete-confirm', open: ['screens-delete-run'] },
    ],
  },
];

/** The file name's part of a dialog: its name, else its test id. */
export const modalName = (modal) => modal.name ?? modal.testId;

const VERBS = ['click', 'check', 'uncheck', 'hover', 'fill', 'select', 'upload'];

/**
 * A dialog's steps in one shape (the manifest's too):
 * {do, testId?, key?, css?, value?, file?, ms?, device?}.
 */
export const normalizeSteps = (steps = []) =>
  steps.map((step) => {
    if (typeof step === 'string') {
      return { do: 'click', testId: step };
    }
    if (step.wait != null) {
      return { do: 'wait', ms: step.wait };
    }
    if (step.press != null) {
      return { do: 'press', value: step.press };
    }
    const verb = VERBS.find((name) => step[name] != null);
    if (!verb) {
      throw new Error(`A step without a verb: ${JSON.stringify(step)}`);
    }
    const target = step[verb];
    return {
      do: verb,
      ...(typeof target === 'string' ? { testId: target } : { css: target.css }),
      ...(step.key != null ? { key: String(step.key) } : {}),
      ...(step.value != null ? { value: step.value } : {}),
      ...(step.file ? { file: { name: step.file.name, content: step.file.content, mimeType: step.file.mimeType } } : {}),
      ...(step.device ? { device: step.device } : {}),
    };
  });
