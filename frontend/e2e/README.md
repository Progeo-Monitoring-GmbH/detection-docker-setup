# UI tests (Playwright)

Browser tests of the frontend. They find elements by their `data-testid`,
which every major element carries (`src/testIds.ts`).

## Running them

```bash
cd frontend
npm run e2e:install          # once: downloads Chromium for Playwright
export E2E_USERNAME=...      # a test user WITHOUT 2FA
export E2E_PASSWORD=...
export E2E_LOCATION_ID=3031  # optional: a location the user sees (location pages)
npm run e2e                  # all tests, headless
npm run e2e:ui               # Playwright's UI mode: pick, watch and debug tests
```

Without `E2E_BASE_URL` the tests run against the local dev server
(`http://localhost:3000`). It is started when it is not running already. With
`E2E_BASE_URL=https://...` they run against that server, e.g. staging.

`e2e/auth.setup.ts` logs in once and stores the session in `e2e/.auth/`
(git-ignored). The tests reuse it. The report of the last run is in
`e2e/report/` (`npx playwright show-report e2e/report`).

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
