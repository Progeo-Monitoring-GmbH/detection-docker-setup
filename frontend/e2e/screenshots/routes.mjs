// The screens the e2e_screenshots command captures (capture.mjs): every route
// of the app with the parameters that show something, who sees it, and the
// dialogs that open on it.
//
//   action  - the file name's last part: {pc|mobile}-{user|staff}-{de|en}-{action}.png
//   path    - opened as is (the mocked location is #1, escalation #1)
//   roles   - "user": a customer with the usual module permissions,
//             "staff": staff (and superuser - every page) - see mockApi.mjs
//   public  - opened without a login (captured once, as "user")
//   consent - the cookie consent's categories other than the default (all
//             declined), e.g. { externalMaps: true } for a page with a map
//   unfold  - false: the FoldPanels stay folded (default: capture.mjs unfolds
//             them all after loading - before the page's and its dialogs' shots)
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
//               `position: { x, y }` clicks that point of the element (a plot);
//               `device: 'mobile' | 'pc'` - a step on that device only (e.g. a
//               phone table's row expander); `role: 'user' | 'staff'` - for
//               that role only (e.g. a switch only staff have).
//     name      the file name's dialog part (a-z, 0-9, -) - default: testId
//     roles     fewer than the page's (default: the page's)
//     devices   only these (default: all)
//     path      opened on another URL (default: the page's)
//     scenario  a variant of the mocked data (mockApi.mjs SCENARIOS)
//     unfold    false: opened with the FoldPanels folded (default: the page's)
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
/** react-data-table's own selection checkbox (selectableRows) of the first row under `scope`. */
const selectTableRow = (scope) => ({
  check: { css: `${scope} .rdt_TableBody input[type="checkbox"]` },
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

/** The controller's commands dialog of device #1 (device list). */
const OPEN_COMMANDS = [
  expandRow(1),
  { click: 'device-list-commands', key: '1' },
];

/** The climate panels' dialogs of a LoRaWAN project (`prefix`: the panels' test id). */
const climateModals = (prefix) =>
  [
    { testId: 'device-rename-modal', open: [`${prefix}-rename-devices`] },
    { testId: `${prefix}-clean-dialog`, open: [`${prefix}-clean`] },
    {
      testId: `${prefix}-import-dialog`,
      open: [
        {
          upload: `${prefix}-import-file`,
          file: {
            name: 'messungen-4700.json',
            content: JSON.stringify({
              data: [
                { clazz: 'Measurement', id: 1 },
                { clazz: 'Measurement', id: 2 },
              ],
            }),
          },
        },
      ],
    },
  ].map((modal) => ({ ...modal, roles: ['staff'], scenario: 'lorawan' }));

/**
 * A notification case opened by a click on its row: DataTable takes a row
 * click only on the cell itself (not the badge in it) - its empty right part.
 */
const openCase = (id) => ({
  click: {
    css: `.rdt_TableCell:has([data-testid="staff-notifications-kind"][data-test-key="${id}"])`,
  },
  position: { x: 90, y: 8 },
});

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
      {
        testId: 'airtable-sync-dialog',
        roles: ['staff'],
        open: ['airtable-sync-button'],
      },
    ],
  },
  {
    action: 'location-status',
    path: '/location/1/status',
    roles: ['user', 'staff'],
    modals: [
      {
        // Dissolving needs module_locations_mergable - not the plain customer's.
        testId: 'location-group-dissolve-dialog',
        roles: ['staff'],
        open: ['location-group-dissolve'],
      },
      // A LoRaWAN project: climate panels with their own dialogs (superuser).
      ...climateModals('climate-panels'),
      {
        // The per-sensor list: staff only, after switching from the computed points.
        testId: 'verdachtsstelle-acknowledge-dialog',
        roles: ['staff'],
        open: [
          { click: 'suspicion-mode-option', key: 'sensors' },
          { click: 'verdachtsstelle-toggle', key: 'sensor-6' },
          { click: 'verdachtsstelle-acknowledge', key: 'sensor-6' },
        ],
      },
      {
        // The computed points (the default, mx-PEEL has the most).
        testId: 'computed-suspicion-acknowledge-dialog',
        scenario: 'mx-peel',
        open: [
          { click: 'suspicion-mode-option', key: 'computed', role: 'staff' },
          { click: 'computed-suspicion-toggle', key: 'point-1' },
          { click: 'computed-suspicion-acknowledge', key: 'point-1' },
        ],
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
          // The plot picks the sensor under the click: the first column.
          {
            click: 'measurement-compare-columns-plot',
            position: { x: 12, y: 120 },
          },
          'analyse-sensor-disable',
        ],
      },
      ...climateModals('analyse-climate-panels'),
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
  // The "Alarmablauf" tab: the open notification cases as timelines.
  { action: 'escalations-flow', path: '/escalations/?view=flow', roles: ['staff'] },
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
      // maintenance / normal are outdated - no buttons any more (DeviceCommandsDialog).
      {
        testId: 'device-commands-restart-dialog',
        open: [...OPEN_COMMANDS, { click: 'device-commands-command', key: 'restart' }],
      },
      {
        // The commands dialog with its file editor open ("Config überschreiben").
        testId: 'device-commands-update',
        open: [...OPEN_COMMANDS, 'device-commands-update-open'],
      },
      {
        testId: 'device-commands-send-params-dialog',
        open: [...OPEN_COMMANDS, 'device-commands-send-params'],
      },
      {
        testId: 'device-commands-send-update-dialog',
        open: [
          ...OPEN_COMMANDS,
          // The file editor only after "Config überschreiben".
          'device-commands-update-open',
          {
            fill: 'device-commands-update-content',
            value: '[measure]\ninterval = 3600',
          },
          'device-commands-send-update',
        ],
      },
      {
        testId: 'device-commands-cancel-command-dialog',
        scenario: 'pending-command',
        open: [...OPEN_COMMANDS, { click: 'device-commands-cancel', key: '3' }],
      },
      {
        testId: 'device-commands-firmware-start-dialog',
        open: [
          expandRow(1),
          { click: 'device-list-commands', key: '1' },
          'device-commands-firmware-start',
        ],
      },
      {
        testId: 'provision-test-clear-dialog',
        open: [
          expandRow(1),
          { click: 'device-list-test-measurements', key: '1' },
          'provision-test-clear',
        ],
      },
      {
        testId: 'provision-test-commands-dialog',
        open: [
          expandRow(1),
          { click: 'device-list-test-measurements', key: '1' },
          'provision-test-commands',
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
      {
        testId: 'lageplan-wizard-import-dialog',
        open: [
          // A phone shows the sources as a dropdown (they don't fit in one row).
          { click: 'lageplan-wizard-point-source-option', key: 'json', device: 'pc' },
          { select: 'lageplan-wizard-point-source-select', value: 'json', device: 'mobile' },
          {
            upload: 'lageplan-wizard-import-json-input',
            file: {
              name: 'messpunkte-4700.json',
              content: JSON.stringify({
                points: [{ x: 0.2, y: 0.3, device: 1, sensor_order: 1 }],
              }),
            },
          },
        ],
      },
      {
        // Device #2 taken off the plan - saving replaces device #1's points.
        testId: 'lageplan-wizard-placement-save-dialog',
        open: [
          { click: 'lageplan-wizard-sensor-device', key: '2' },
          'lageplan-wizard-sensor-remove',
          'lageplan-wizard-placement-save',
        ],
      },
      {
        testId: 'lageplan-wizard-heat-limits-heat-limit-delete-dialog',
        open: [
          { click: 'lageplan-wizard-heat-limits-heat-limit-delete', key: 'hl-1' },
        ],
      },
      {
        testId: 'lageplan-wizard-heat-limits-heat-limit-copy-dialog',
        open: ['lageplan-wizard-heat-limits-heat-limit-copy'],
      },
    ],
  },
  // The map only shows with the external maps accepted (tiles: capture.mjs TILE_SERVERS).
  { action: 'map', path: '/map/', roles: ['staff'], consent: { externalMaps: true } },
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
        open: [openCase(1)],
      },
      {
        testId: 'staff-notifications-close-dialog',
        open: [
          openCase(1),
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
      { testId: 'backup-restore-dialog', open: [{ click: 'backup-restore', key: '1' }] },
      { testId: 'backup-delete-dialog', open: [{ click: 'backup-delete', key: '1' }] },
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
        name: 'docker-stop',
        testId: 'docker-confirm',
        open: [{ click: 'docker-container-start-stop', key: 'a1b2c3d4e5f60001' }],
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
      {
        testId: 'screen-note-delete-dialog',
        open: [
          { click: 'screen-card-comment', key: 'pc-user-de-login.png' },
          {
            click: {
              css: '[data-testid="screen-note"][data-test-key="1"] [data-testid="screen-note-delete"]',
            },
          },
        ],
      },
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
      ...(step.position ? { position: { x: step.position.x, y: step.position.y } } : {}),
      ...(step.file ? { file: { name: step.file.name, content: step.file.content, mimeType: step.file.mimeType } } : {}),
      ...(step.device ? { device: step.device } : {}),
      ...(step.role ? { role: step.role } : {}),
    };
  });
