import type { Locator, Page } from '@playwright/test';
import { blockDestructive, expect, test } from './fixtures';

/**
 * The slider of /staff/thresholds/ (ThresholdFineTuneView, module_admin_thresholds):
 * the maximum (red), the threshold now (orange) and the proposal (green) as
 * numbered ticks on the track, red stripes below the maximum (the location
 * would alarm) and green stripes up to the scan's safety buffer.
 *
 * The page gets a findings file of its own (page.route) - staging may have
 * none, and its numbers would change. Applying and removing never reach the
 * server (blockDestructive): the confirm buttons are not clicked anyway.
 * Without module_admin_thresholds for the staff user the tests skip.
 */

const PAGE = '/staff/thresholds/';
const API = '/v1/threshold-fine-tune/';
const FILE = 'fine_tune_20261123_080000.json';
const BUFFER = 25;
const THUMB = 16; // --ftt-thumb in ThresholdFineTuneView.css

const entry = (
  key: string,
  name: string,
  values: { max: number; current: number; proposed: number },
) => ({
  key,
  location_id: Number(key.split(':')[1]),
  project_id: 9900 + Number(key.split(':')[1]),
  name,
  current_threshold: values.current,
  live_threshold: values.current,
  max_value: values.max,
  max_at: {
    value: values.max,
    sensor_order: 3,
    device_id: 1,
    at: '2026-11-22T10:00:00',
  },
  action: values.proposed < values.current ? 'lower' : 'raise',
  proposed: values.proposed,
  change_percent: ((values.proposed - values.current) / values.current) * 100,
  measurements: 500,
  excluded_sensors: [],
  active_alarms: 0,
  warnings: [],
});

// Range 30..160 (sliderRange: half the smallest, 1.6 times the largest value).
const SPREAD = entry('default:1', 'E2E Halle weit', {
  max: 60,
  current: 100,
  proposed: 75,
});
// Maximum and threshold close together: the threshold's number moves one row lower.
const CROWDED = entry('default:2', 'E2E Halle eng', {
  max: 95,
  current: 100,
  proposed: 119,
});

const FINDINGS = {
  file: FILE,
  created_at: new Date().toISOString(),
  params: {
    days: 30,
    buffer_percent: BUFFER,
    minimum: 30,
    max_raise_percent: 15,
    step_minutes: null,
    projects: null,
  },
  summary: { lower: 1, raise: 1 },
  locations: [SPREAD, CROWDED],
  stale: null,
};

/** The page with the findings above; skips without the permission. */
const openThresholds = async (page: Page) => {
  const sent = await blockDestructive(page, [
    { url: /\/v1\/threshold-fine-tune\/.+\/(apply|remove)\// },
  ]);
  // Registered after the guard: these answer first.
  await page.route(`**${API}`, (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({
          json: {
            success: true,
            files: [
              {
                file: FILE,
                created_at: FINDINGS.created_at,
                locations: 2,
                applied: 0,
              },
            ],
          },
        })
      : route.fallback(),
  );
  await page.route(`**${API}${FILE}/`, (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ json: { success: true, findings: FINDINGS } })
      : route.fallback(),
  );

  await page.goto(PAGE);
  const shown = await page
    .getByTestId('page-threshold-fine-tune')
    .waitFor({ state: 'visible', timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  test.skip(!shown, `${PAGE}: the staff user lacks module_admin_thresholds`);
  await expect(cell(page, SPREAD.key)).toBeVisible();
  return sent;
};

const cell = (page: Page, key: string) =>
  page.locator(`[data-testid="ftt-threshold"][data-test-key="${key}"]`);
const mark = (row: Locator, kind: 'max' | 'current' | 'proposed') =>
  row.locator(`[data-testid="ftt-mark"][data-test-key="${kind}"]`);
const margin = (page: Page, key: string) =>
  page.locator(`[data-testid="ftt-margin"][data-test-key="${key}"]`);

const box = async (locator: Locator) => {
  const found = await locator.boundingBox();
  expect(found, 'the element is laid out').not.toBeNull();
  return found!;
};

/** Where the slider's thumb centre sits for `value` (the thumb travels THUMB/2 in from either end). */
const thumbX = async (slider: Locator, value: number) => {
  const { x, width } = await box(slider);
  const min = Number(await slider.getAttribute('min'));
  const max = Number(await slider.getAttribute('max'));
  return x + THUMB / 2 + (width - THUMB) * ((value - min) / (max - min));
};

/** The x of a tick (its centre). */
const tickX = async (row: Locator, kind: 'max' | 'current' | 'proposed') => {
  const tick = await box(mark(row, kind).locator('.ftt-mark-tick'));
  return tick.x + tick.width / 2;
};

test.describe('threshold slider', () => {
  test('shows maximum, threshold and proposal on the track, each where the thumb would stand', async ({
    page,
    expectUniqueTestIds,
  }) => {
    await openThresholds(page);
    const row = cell(page, SPREAD.key);
    const slider = row.getByTestId('ftt-slider');

    // The three values, left to right, with their numbers.
    const marks = row.getByTestId('ftt-mark');
    await expect(marks).toHaveCount(3);
    expect(
      await marks.evaluateAll((all) =>
        all.map((m) => [m.getAttribute('data-test-key'), m.textContent]),
      ),
    ).toEqual([
      ['max', '60'],
      ['proposed', '75'],
      ['current', '100'],
    ]);
    // Their colours: red, green, orange.
    const colour = (kind: 'max' | 'current' | 'proposed') =>
      mark(row, kind)
        .locator('.ftt-mark-tick')
        .evaluate((tick) => getComputedStyle(tick).backgroundColor);
    expect(await colour('max')).toBe('rgb(208, 59, 59)');
    expect(await colour('proposed')).toBe('rgb(46, 139, 58)');
    expect(await colour('current')).toBe('rgb(235, 99, 59)');

    // Each tick sits where the thumb stands at its value.
    for (const [kind, value] of [
      ['max', 60],
      ['proposed', 75],
      ['current', 100],
    ] as const) {
      expect(
        Math.abs((await tickX(row, kind)) - (await thumbX(slider, value))),
        `the ${kind} tick`,
      ).toBeLessThan(1.5);
    }
    // The track runs through the thumb's middle, the number above the track.
    const track = await box(row.locator('.ftt-track'));
    const input = await box(slider);
    expect(
      Math.abs(track.y + track.height / 2 - (input.y + input.height / 2)),
    ).toBeLessThan(1.5);
    expect(
      (await box(mark(row, 'max').locator('.ftt-mark-value'))).y + 8,
    ).toBeLessThan(track.y);

    // Red stripes up to the maximum, green ones on to the buffer (25 % above it).
    const unsafe = await box(row.getByTestId('ftt-zone-unsafe'));
    const buffer = await box(row.getByTestId('ftt-zone-buffer'));
    expect(
      Math.abs(unsafe.x - track.x),
      'red from the start of the track',
    ).toBeLessThan(1);
    expect(
      Math.abs(unsafe.x + unsafe.width - (await thumbX(slider, 60))),
      'red ends at the maximum',
    ).toBeLessThan(1.5);
    expect(
      Math.abs(buffer.x - (unsafe.x + unsafe.width)),
      'green follows red',
    ).toBeLessThan(1);
    expect(
      Math.abs(
        buffer.x +
          buffer.width -
          (await thumbX(slider, 60 * (1 + BUFFER / 100))),
      ),
      'green ends at the buffer',
    ).toBeLessThan(1.5);
    expect(
      await row.getByTestId('ftt-zone-unsafe').getAttribute('title'),
    ).toMatch(/60/);

    // The value columns wear the colours of their marks.
    const valueColour = async (kind: 'max' | 'current' | 'proposed') =>
      page
        .locator(`.ftt-value--${kind}`)
        .first()
        .evaluate((element) => getComputedStyle(element).color);
    expect(await valueColour('max')).toBe('rgb(208, 59, 59)');
    expect(await valueColour('current')).toBe('rgb(235, 99, 59)');
    expect(await valueColour('proposed')).toBe('rgb(46, 139, 58)');

    await expectUniqueTestIds();
  });

  test('the columns can be resized, the width is kept', async ({ page }) => {
    await openThresholds(page);
    const header = page.locator('.rdt_TableCol[data-column-id="location"]');
    const before = (await box(header)).width;
    const handle = await box(header.locator('.rdt_resizeHandle'));

    await page.mouse.move(
      handle.x + handle.width / 2,
      handle.y + handle.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      handle.x + handle.width / 2 + 80,
      handle.y + handle.height / 2,
      { steps: 6 },
    );
    await page.mouse.up();

    const after = (await box(header)).width;
    expect(after - before, 'the location column is wider').toBeGreaterThan(60);
    await page.reload();
    await expect(cell(page, SPREAD.key)).toBeVisible();
    expect(
      Math.abs((await box(header)).width - after),
      'the width survives a reload',
    ).toBeLessThan(2);
  });

  test('moves a number one row lower when two values are close', async ({
    page,
  }) => {
    await openThresholds(page);
    const row = cell(page, CROWDED.key);

    await expect(mark(row, 'current')).toHaveClass(/ftt-mark--low/);
    await expect(mark(row, 'max')).not.toHaveClass(/ftt-mark--low/);
    await expect(mark(row, 'proposed')).not.toHaveClass(/ftt-mark--low/);
    // The numbers don't overlap.
    const max = await box(mark(row, 'max').locator('.ftt-mark-value'));
    const current = await box(mark(row, 'current').locator('.ftt-mark-value'));
    const apart =
      current.y >= max.y + max.height || current.x >= max.x + max.width;
    expect(apart, 'the threshold number clears the maximum number').toBe(true);
  });

  test('sliding sets the value, the margin follows and the row is selected', async ({
    page,
  }) => {
    const sent = await openThresholds(page);
    const row = cell(page, SPREAD.key);
    const slider = row.getByTestId('ftt-slider');
    const number = row.getByTestId('ftt-number');

    // Starts at the proposal: 75 is 25 % above the maximum 60 - the buffer exactly.
    await expect(number).toHaveValue('75');
    await expect(margin(page, SPREAD.key)).toHaveClass(/ftt-margin--ok/);
    await expect(margin(page, SPREAD.key)).toContainText('+25');

    // Keyboard: one step down - inside the green stripes, less than the buffer.
    await slider.focus();
    await page.keyboard.press('ArrowLeft');
    await expect(number).toHaveValue('74');
    await expect(margin(page, SPREAD.key)).toHaveClass(/ftt-margin--warn/);

    // A click on the red stripes, left of the maximum: the location would alarm.
    const track = await box(row.locator('.ftt-track'));
    await page.mouse.click(
      await thumbX(slider, 45),
      track.y + track.height / 2,
    );
    const picked = Number(await number.inputValue());
    expect(
      Math.abs(picked - 45),
      'the click lands near 45',
    ).toBeLessThanOrEqual(2);
    await expect(margin(page, SPREAD.key)).toHaveClass(/ftt-margin--danger/);

    // Dragging the thumb right of the threshold now.
    await page.mouse.move(
      await thumbX(slider, picked),
      track.y + track.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      await thumbX(slider, 110),
      track.y + track.height / 2,
      { steps: 8 },
    );
    await page.mouse.up();
    const dragged = Number(await number.inputValue());
    expect(
      Math.abs(dragged - 110),
      'the drag ends near 110',
    ).toBeLessThanOrEqual(2);
    await expect(margin(page, SPREAD.key)).toHaveClass(/ftt-margin--ok/);

    // The marks stay where they are.
    expect(
      Math.abs((await tickX(row, 'max')) - (await thumbX(slider, 60))),
    ).toBeLessThan(1.5);

    // Moving the slider selected the row: "apply" lists it with the chosen value.
    const apply = page.getByTestId('ftt-apply');
    await expect(apply).toBeEnabled();
    await apply.click();
    await expect(page.getByTestId('ftt-apply-row')).toContainText(
      `100 → ${dragged}`,
    );
    expect(sent, 'nothing was applied').toHaveLength(0);
  });

  test('typing a number moves the thumb onto the tick', async ({ page }) => {
    await openThresholds(page);
    const row = cell(page, SPREAD.key);
    const slider = row.getByTestId('ftt-slider');

    await row.getByTestId('ftt-number').fill('100');

    await expect(slider).toHaveValue('100');
    await expect(margin(page, SPREAD.key)).toHaveClass(/ftt-margin--ok/);
    // No changed value: the number field is not marked as a change.
    await expect(row.getByTestId('ftt-number')).not.toHaveClass(
      /ftt-number--changed/,
    );
  });
});
