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

const api = vi.hoisted(() => ({ get: vi.fn() }));
const hooks = vi.hoisted(() => ({
  auth: { user: { is_staff: true } },
  snackbar: { enqueueSnackbar: vi.fn() },
  translation: {
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  },
}));

vi.mock('../axiosConfig', () => ({
  default: {
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
            ],
          },
        });
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

const { default: LocationChecklistView, checkDetail } =
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
    expect(byKey('checklist-detail', 'sensor_devices')!.textContent).toContain(
      'readiness_detail_sensor_devices_uncovered:{"count":2}; readiness_detail_sensor_devices_count:{"counted":30,"points":28}',
    );
    expect(byKey('checklist-fix', 'sensor_devices')!.getAttribute('href')).toBe(
      '/lageplan/wizard/?location=7',
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
