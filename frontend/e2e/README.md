# UI tests (Playwright)

Browser tests of the frontend. They find elements by their `data-testid`,
which every major element carries (`src/testIds.ts`).

## Running them

```bash
cd frontend
npm run e2e:install          # once: downloads Chromium for Playwright
export E2E_USERNAME=...      # email address of a test user WITHOUT 2FA (login is by email only)
export E2E_PASSWORD=...
export E2E_LOCATION_ID=3031  # optional: a location the user sees (location pages)
export E2E_DEMO_PASSWORD=... # the demo test users (see "Test users on staging")
npm run e2e                  # all tests, headless
npm run e2e:ui               # Playwright's UI mode: pick, watch and debug tests
```

Without `E2E_BASE_URL` the tests run against the local dev server
(`http://localhost:3000`). It is started when it is not running already. With
`E2E_BASE_URL=https://...` they run against that server, e.g. staging.

`e2e/auth.setup.ts` logs in once and stores the session in `e2e/.auth/`
(git-ignored). The tests reuse it. The report of the last run is in
`e2e/report/` (`npx playwright show-report e2e/report`).

### Test users on staging

Besides the staff user (`E2E_USERNAME`), the permission, unsubscribe and
media tests log in as people of the **demo account**, so nothing a test does
touches customer data (`e2e/roles.ts`, backend `progeo/helper/e2e.py`):

| role | demo person | rights |
| --- | --- | --- |
| `customer` | `demo.erika.mustermann@progeo.com` | account member, a customer's usual rights (no edit/delete/revoke/invite) |
| `single` | `demo.jonas.weber@progeo.com` | access to the smartex dm demo location (9001) only |
| `subscriber` | `demo.max.mustermann@progeo.com` | account member with alarm mails (unsubscribe test) and the login QR code permission |

Set it up once on staging:

```bash
# .env of staging: E2E_DEMO_PASSWORD=<a long random password>, restart the backend
docker exec -it progeo-backend python manage.py demo_account --e2e   # or a full demo_account run
```

The nightly staging import (`import_live_backup`) re-applies it. Where the
tests run, set the same `E2E_DEMO_PASSWORD`. `e2e/auth.setup.ts` then logs
every role in and fetches the ids it needs from `/v1/e2e/info/` (staff only,
404 without `E2E_DEMO_PASSWORD` on the server). Without it the role tests skip.
Optional: `E2E_SUPERUSER_USERNAME` / `E2E_SUPERUSER_PASSWORD` (a superuser
without 2FA) for the backup-download check, `E2E_API_URL` when the API isn't
on the frontend's origin.

### What the tests check

- `permissions.e2e.ts` - users without a right try it (revoke, another
  user's password, edit/delete a location, another account's location, a
  location outside their scope): the server refuses (403/404, also checked on
  the API) and the app shows an error toast and keeps the page. Hidden buttons
  are shown with `grantInBrowser()` (only the browser believes the right).
- `unsubscribe.e2e.ts` - the unsubscribe link of an alarm mail, with the
  subscription checked before and after (and switched on again).
- `media.e2e.ts` - `/media/` needs a login, backups a superuser.
- `profile-qr-code.e2e.ts` - the login QR code in Mein Konto
  (`module_profile_qr_code`): hidden and refused without the permission; with
  it (the `subscriber` role) the code is generated, shown, hidden and offered
  again as "QR-Code zeigen".
- `login-throttle.e2e.ts` - failed logins make the wait grow.
- `destructive-*.e2e.ts` - every destructive button asks first and explains
  the consequences (`expectConfirmGuard()`); the requests are blocked
  (`blockDestructive()`), the confirm button is never clicked.

New tests go in `e2e/*.e2e.ts` and import `test` and `expect` from
`./fixtures`. `e2e/smoke.e2e.ts` is a starting point. Vitest does not pick
them up: it only runs `*.spec.ts(x)`.

## Test ids

- **Format:** `data-testid` in kebab-case, `<page-or-component>-<element>`,
  e.g. `lageplan-wizard-step-3` or `analyse-heatmap-plans`. Build them with
  `testId()` / `childTestId()` from `src/testIds.ts` when they contain values.
- **Page roots:** every route's outermost element is `page-<name>`, e.g.
  `page-location-analyse`, `page-lageplan-wizard`, `page-login`. Tests wait
  for it before they start (`openPage()` in `fixtures.ts`).
- **Repeated elements** (rows, tiles, options, chips) keep **one** test id and
  are told apart by `data-test-key`. The key is the item's id or value, never
  its index:

  ```tsx
  <div {...repeatedTestId('lageplan-tile', plan.id)}>
  ```

  ```ts
  page.getByTestId('lageplan-tile').and(page.locator('[data-test-key="1894"]'))
  ```

- **Unique:** a test id without a key occurs once per page.
  `expectUniqueTestIds()` (fixtures) checks this, and `duplicateTestIds()` can
  do the same in unit specs.
- **Kit components** take a `testId` prop and derive their children from it:
  - `ConfirmDialog`: `-confirm` and `-cancel`.
  - `SegmentedControl`: `-option`, with the option's value as its key.
  - `SearchableDataTable`: `-search` and `-count`.
  - `StatTile`: `-value`.
- **Stable:** a test id names what an element *is*, not its text (the UI is
  German and English) or its look. Don't rename one without updating the tests.
- **Not `id`:** `id` attributes are for labels and ARIA (`htmlFor`,
  `aria-controls`) and stay as they are.

Where an element has a clear role and name, a test may also use
`getByRole('button', { name: ... })`. Test ids are the stable way for
everything else.

## Screenshots of every screen (screen review)

`python manage.py e2e_screenshots` takes full-page screenshots of every route
(`e2e/screenshots/routes.mjs`) - pc (1440×900) and mobile (390×844), as a
normal user and as staff - against the dev server with mocked API answers
(`e2e/screenshots/mockApi.mjs`, no backend or database). They land in
`media/uploads/e2e/<YYYY-MM-DD_HHMMSS>/{pc,mobile}/{pc|mobile}-{user|staff}-{action}.png`
with a `manifest.json`, and are reviewed at `/review/screens/` (staff):
comments with arrows or areas, exported as a ZIP with a `PROMPT.md`.

```bash
python manage.py e2e_screenshots                                   # everything (~30 min, ~4 without dialogs)
python manage.py e2e_screenshots --devices mobile --only location-status,staff-admin
python manage.py e2e_screenshots --base-url http://127.0.0.1:3000  # a dev server started
                                                                   # with VITE_BACKEND_URL=http://127.0.0.1:59999
```

On a server (`docker exec -it progeo-backend python manage.py e2e_screenshots`)
the backend container has no frontend and no Node: the command then asks the
Docker agent to run the `progeo-e2e_screens` image (`docker/e2e_screens/`) -
build it once (and after frontend changes) with
`docker compose --profile e2e_screens build progeo-e2e_screens`
(production: the `e2e_screens-<version>` image, like `cad_factory`).

A new page: add it to `routes.mjs`. A screen showing empty data or a page
error: the run's `manifest.json` lists per screenshot the requests without a
mock (`unmocked`) and the page errors - add those answers to `mockApi.mjs`.

### Dialogs

Every dialog a user or staff member can open (Modal, ConfirmDialog, drawer)
gets its own screenshot too: `{...}-{action}--{dialog}.png`, the window with
the dialog open (not the full page - the dialog is fixed to the window; a
taller dialog grows the window to fit). A route lists its dialogs in
`modals`, each opened from a freshly loaded page by clicking test ids:

```js
{
  action: 'staff-admin', path: '/staff/', roles: ['staff'],
  modals: [
    { testId: 'staff-user-create', open: ['staff-users-add'] },
    {
      testId: 'staff-user-edit-dialog',
      open: [
        expandRow(2),                               // phones: the row's expander first
        { click: 'staff-user-edit', key: '2' },     // data-test-key of a repeated button
      ],
    },
  ],
},
```

A new ConfirmDialog is one line in its page's `modals`:
`{ testId: '<area>-<action>-dialog', open: ['<area>-<action>'] }`. The steps
(`click`, `check`, `fill`, `select`, `upload`, `hover`, `press`, `wait`, a CSS
selector for elements without a test id, `device: 'mobile'` for a phone-only
step) and the other options (`name`, `roles`, `devices`, `path`, `scenario` -
a variant of the mocked data) are described at the top of `routes.mjs`.

The manifest records for every screenshot the URL it was taken on and, for a
dialog, the steps and the dialog's test id; a dialog that does not open is no
screenshot but an entry in `failures` with the reason (the step that failed).
The review page shows the URL as a link into the portal, the dialog and its
steps next to its page, and the failures above the gallery.

```bash
python manage.py e2e_screenshots --only staff-admin                       # the page and its dialogs
python manage.py e2e_screenshots --only staff-admin--staff-user-create    # one dialog
python manage.py e2e_screenshots --no-modals                              # the pages only (local runs)
```

Run it while nobody edits the frontend: the dev server reloads changed files,
and a page reloaded mid-capture fails ("Failed to fetch dynamically imported
module").
