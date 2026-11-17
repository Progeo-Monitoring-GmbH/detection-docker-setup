// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import type { TFunction } from 'i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { duplicateTestIds } from '../testIds';
import type { ReadinessCheck } from './LocationChecklistView';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const check = (
  key: string,
  group: string,
  status: ReadinessCheck['status'],
  values = {},
  optional = false,
) => ({
  key,
  group,
  weight: 2,
  optional,
  status,
  values,
});

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
const hooks = vi.hoisted(() => ({
  auth: { user: { is_staff: true } },
  snackbar: { enqueueSnackbar: vi.fn() },
  translation: {
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  },
}));

// Location 5: not linked to Airtable - "Beheben" loads the project.
const airtableReadiness = (status: 'pass' | 'fail', extra = {}) => ({
  location: { id: 5, project_id: 5005, name: 'Halle 5', purgeable: null },
  score: status === 'pass' ? 100 : 90,
  level: status === 'pass' ? 'ready' : 'almost',
  at: '2026-11-17T10:00:00Z',
  checks: [check('airtable', 'base', status, {}, true)],
  ...extra,
});

vi.mock('../axiosConfig', () => ({
  default: {
    perform_post: (
      _auth: unknown,
      url: string,
      body: { accept?: Record<string, unknown> },
      ok: (response: unknown) => void,
    ) => {
      api.post(url, body);
      if (!body.accept) {
        // First the changes to confirm - nothing saved.
        ok({
          data: {
            airtable: {
              status: 'preview',
              project_id: 5005,
              fields: [],
              changes: [
                { field: 'name', old: { value: 'Alt', label: 'Alt' }, new: { value: 'Halle 5', label: 'Halle 5' } },
                {
                  field: 'airtable_url',
                  old: { value: null, label: null },
                  new: { value: 'https://airtable.com/rec5', label: 'https://airtable.com/rec5' },
                },
              ],
            },
          },
        });
        return;
      }
      ok({
        data: airtableReadiness('pass', {
          airtable: { status: 'updated', fields: Object.keys(body.accept), skipped: [], changes: [], project_id: 5005 },
        }),
      });
    },
    perform_get: (
      _auth: unknown,
      url: string,
      ok: (response: unknown) => void,
    ) => {
      api.get(url);
      if (url === '/v1/location/min/') {
        ok({
          data: [
            { id: 7, name: 'Halle 7', project_id: 7078, readiness_score: 40 },
          ],
        });
      } else if (url === '/v1/location/7/readiness/') {
        ok({
          data: {
            location: {
              id: 7,
              project_id: 7078,
              name: 'Halle 7',
              purgeable: null,
            },
            score: 64,
            level: 'progress',
            at: '2026-11-17T10:00:00Z',
            airtable_filled: ['plz', 'city'],
            checks: [
              check('address', 'base', 'pass'),
              check('devices_online', 'devices', 'fail', {
                offline: 1,
                total: 2,
                names: 'Keller',
              }),
              check('sensor_devices', 'points', 'fail', {
                uncovered: 2,
                ambiguous: 0,
                counted: 30,
                points: 28,
              }),
              check('points_named', 'points', 'na', {}, true),
              check('lageplan_cropped', 'plan', 'fail', { span: 30 }, true),
            ],
          },
        });
      } else if (url === '/v1/location/5/readiness/') {
        ok({ data: airtableReadiness('fail') });
      } else if (url === '/v1/location/readiness/') {
        ok({
          data: {
            locations: [
              {
                id: 9,
                project_id: 9001,
                name: 'Leer',
                city: null,
                purgeable: null,
                score: null,
                level: null,
                at: null,
                failed: [],
              },
              {
                id: 7,
                project_id: 7078,
                name: 'Halle 7',
                city: 'Köln',
                purgeable: null,
                score: 64,
                level: 'progress',
                at: '2026-11-17T10:00:00Z',
                failed: ['devices_online', 'sensor_devices'],
              },
              {
                id: 8,
                project_id: 8080,
                name: 'Fertig',
                city: 'Bonn',
                purgeable: null,
                score: 100,
                level: 'ready',
                at: '2026-11-17T10:00:00Z',
                failed: [],
              },
            ],
          },
        });
      }
    },
  },
}));
vi.mock('../../hooks/CoreAuthProvider', () => ({ useAuth: () => hooks.auth }));
vi.mock('notistack', () => ({ useSnackbar: () => hooks.snackbar }));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTranslation: () => hooks.translation,
}));

const { default: LocationChecklistView, checkDetail, checkPoints, fixPath } =
  await import('./LocationChecklistView');

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // DataTable asks for the colour scheme; jsdom has no matchMedia.
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  api.get.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = (url: string) =>
  act(() => {
    root.render(
      <MemoryRouter initialEntries={[url]}>
        <LocationChecklistView />
      </MemoryRouter>,
    );
  });

const byKey = (testId: string, key: string) =>
  container.querySelector<HTMLElement>(
    `[data-testid="${testId}"][data-test-key="${key}"]`,
  );

describe('LocationChecklistView', () => {
  it('checks the location of the url and shows what is missing with a link to fix it', () => {
    render('/checklist/location/?location=7');

    expect(api.get).toHaveBeenCalledWith('/v1/location/7/readiness/');
    expect(
      container.querySelector('[data-testid="checklist-score"]')!.textContent,
    ).toBe('64/100');
    expect(
      container.querySelector('[data-testid="checklist-level"]')!.textContent,
    ).toBe('readiness_level_progress');

    expect(
      byKey('checklist-check', 'address')!.getAttribute('data-status'),
    ).toBe('pass');
    expect(byKey('checklist-detail', 'address')).toBeNull();

    expect(byKey('checklist-detail', 'devices_online')!.textContent).toContain(
      'readiness_detail_devices_online:{"offline":1,"total":2,"names":"Keller"}',
    );
    expect(byKey('checklist-fix', 'devices_online')!.getAttribute('href')).toBe(
      '/device/overview?location=7',
    );
    // The checklist stays open.
    expect(
      byKey('checklist-fix', 'devices_online')!.getAttribute('target'),
    ).toBe('_blank');
    expect(
      container.querySelector('[data-testid="checklist-airtable-filled"]')!
        .textContent,
    ).toBe('readiness_airtable_filled:{"fields":"plz, city"}');
    expect(byKey('checklist-detail', 'sensor_devices')!.textContent).toContain(
      'readiness_detail_sensor_devices_uncovered:{"count":2}; readiness_detail_sensor_devices_count:{"counted":30,"points":28}',
    );
    expect(byKey('checklist-fix', 'sensor_devices')!.getAttribute('href')).toBe(
      '/lageplan/wizard/?location=7#wizard-devices',
    );

    expect(byKey('checklist-check', 'points_named')!.textContent).toContain(
      'readiness_optional',
    );
    expect(byKey('checklist-check', 'points_named')!.textContent).toContain(
      'readiness_na',
    );
    // Groups without checks are left out.
    expect(
      container.querySelector('[data-testid="checklist-group-alarming"]'),
    ).toBeNull();
    expect(duplicateTestIds(container)).toEqual([]);
  });

  it('shows a failed optional check as a warning, not an error', () => {
    render('/checklist/location/?location=7');

    const cropped = byKey('checklist-check', 'lageplan_cropped')!;
    expect(cropped.getAttribute('data-status')).toBe('fail');
    expect(cropped.getAttribute('data-severity')).toBe('warn');
    expect(cropped.querySelector('.checklist-icon--warn')).not.toBeNull();
    expect(cropped.querySelector('.checklist-icon--fail')).toBeNull();
    expect(
      byKey('checklist-check', 'devices_online')!.getAttribute('data-severity'),
    ).toBe('fail');
    // Only required checks count as open; the optional one is counted apart.
    expect(
      container.querySelector('[data-testid="checklist-open-count"]')!
        .textContent,
    ).toContain('readiness_open_count:{"count":2,"total":3}');
    expect(
      container.querySelector('[data-testid="checklist-warn-count"]')!
        .textContent,
    ).toBe('readiness_warn_count:{"count":1}');
  });

  it('shows what every check is worth in the score', () => {
    render('/checklist/location/?location=7');

    // Four checks apply, all weight 2: 25 points each; the "na" one counts nothing.
    expect(byKey('checklist-points', 'address')!.textContent).toBe(
      'readiness_points:{"points":"+25"}',
    );
    expect(byKey('checklist-points', 'devices_online')!.textContent).toBe(
      'readiness_points:{"points":"25"}',
    );
    expect(byKey('checklist-points', 'points_named')!.textContent).toBe('–');
  });

  it('lists every location lowest score first without a location', () => {
    render('/checklist/location/');

    expect(api.get).toHaveBeenCalledWith('/v1/location/readiness/');
    expect(api.get).not.toHaveBeenCalledWith(
      expect.stringMatching(/\/\d+\/readiness\//),
    );
    expect(
      container.querySelector('[data-testid="checklist-level-ready"]')!
        .textContent,
    ).toContain('1');
    expect(
      container.querySelector('[data-testid="checklist-level-progress"]')!
        .textContent,
    ).toContain('1');
    expect(
      container.querySelector('[data-testid="checklist-level-never"]')!
        .textContent,
    ).toContain('1');
    expect(
      container.querySelector('[data-testid="checklist-never-hint"]'),
    ).not.toBeNull();
    const table = container.querySelector(
      '[data-testid="checklist-overview-table"]',
    )!.textContent!;
    expect(table.indexOf('Leer')).toBeLessThan(table.indexOf('Halle 7'));
    expect(table).toContain(
      'readiness_check_devices_online · readiness_check_sensor_devices',
    );
    expect(byKey('readiness-badge', 'overview-8')!.textContent).toBe('100');
  });
});

describe('checkPoints', () => {
  it('splits 100 points by weight among the checks that apply', () => {
    const points = checkPoints([
      { ...check('a', 'base', 'pass'), weight: 3 },
      { ...check('b', 'base', 'fail'), weight: 1 },
      { ...check('c', 'base', 'na'), weight: 5 },
    ]);
    expect(points.get('a')).toBe(75);
    expect(points.get('b')).toBe(25);
    expect(points.get('c')).toBe(0);
  });

  it('is 0 everywhere when nothing applies', () => {
    expect(checkPoints([check('a', 'base', 'na')]).get('a')).toBe(0);
  });
});

describe('checkDetail', () => {
  const t = ((key: string, options?: object) =>
    options
      ? `${key}:${JSON.stringify(options)}`
      : key) as unknown as TFunction;

  it('names a missing plan instead of "0 of 0"', () => {
    expect(
      checkDetail(
        t,
        check('lageplan_aligned', 'plan', 'fail', { missing: 0, total: 0 }),
      ),
    ).toBe('readiness_detail_needs_plan');
    expect(
      checkDetail(t, check('lageplan_cropped', 'plan', 'fail', { span: null })),
    ).toBe('readiness_detail_needs_plan');
    expect(
      checkDetail(t, check('lageplan_cropped', 'plan', 'fail', { span: 30 })),
    ).toBe('readiness_detail_lageplan_cropped:{"span":30}');
  });

  it('shows why a location could not be checked', () => {
    expect(
      checkDetail(
        t,
        check('devices', 'devices', 'fail', {
          error: 'database p_1 not readable',
        }),
      ),
    ).toBe('readiness_detail_error:{"error":"database p_1 not readable"}');
  });
});

describe('fixPath', () => {
  it('opens the wizard at the step that fixes the point', () => {
    expect(fixPath('lageplan', 3)).toBe('/lageplan/wizard/?location=3#wizard-plans');
    expect(fixPath('lageplan_resolution', 3)).toBe('/lageplan/wizard/?location=3#wizard-plans');
    expect(fixPath('measure_points', 3)).toBe('/lageplan/wizard/?location=3#wizard-points');
    expect(fixPath('lageplan_aligned', 3)).toBe('/lageplan/wizard/?location=3#wizard-align');
    expect(fixPath('lageplan_calibrated', 3)).toBe('/lageplan/wizard/?location=3#wizard-align');
    expect(fixPath('heat_limitation', 3)).toBe('/lageplan/wizard/?location=3#wizard-heat-limits');
  });

  it('sends alarm recipients to the Rechte tab and the product to the Objekt tab', () => {
    expect(fixPath('alarm_recipient', 3)).toBe('/location/3/rechte');
    expect(fixPath('product', 3)).toBe('/location/3/objekt');
  });

  it('has no link for the Airtable check - it is fixed in place', () => {
    expect(fixPath('airtable', 3)).toBeNull();
    expect(fixPath('dead_sensors_disabled', 3)).toBeNull();
  });
});

describe('LocationChecklistView Airtable fix', () => {
  const inDialog = (selector: string) => document.body.querySelector<HTMLElement>(selector);

  it('shows what Airtable would change and saves only the confirmed changes', () => {
    render('/checklist/location/?location=5');
    const fix = byKey('checklist-fix', 'airtable')!;
    expect(fix.tagName).toBe('BUTTON');

    act(() => fix.click());

    expect(api.post).toHaveBeenLastCalledWith('/v1/location/5/readiness/airtable/', {});
    // Nothing saved yet - the check is still open.
    expect(byKey('checklist-check', 'airtable')!.getAttribute('data-status')).toBe('fail');
    const name = inDialog('[data-testid="checklist-airtable-change"][data-test-key="name"]')!;
    expect(name.textContent).toContain('Alt');
    expect(name.textContent).toContain('Halle 5');

    // The name stays, the link is taken over.
    act(() => name.querySelector('input')!.click());
    act(() => inDialog('[data-testid="checklist-airtable-confirm-confirm"]')!.click());

    expect(api.post).toHaveBeenLastCalledWith('/v1/location/5/readiness/airtable/', {
      accept: { airtable_url: 'https://airtable.com/rec5' },
    });
    expect(byKey('checklist-check', 'airtable')!.getAttribute('data-status')).toBe('pass');
  });

  it('saves nothing when the changes are cancelled', () => {
    render('/checklist/location/?location=5');
    act(() => byKey('checklist-fix', 'airtable')!.click());
    api.post.mockClear();

    act(() => inDialog('[data-testid="checklist-airtable-confirm-cancel"]')!.click());

    expect(api.post).not.toHaveBeenCalled();
    expect(byKey('checklist-check', 'airtable')!.getAttribute('data-status')).toBe('fail');
  });
});
