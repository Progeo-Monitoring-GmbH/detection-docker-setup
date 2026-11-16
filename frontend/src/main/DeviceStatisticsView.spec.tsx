// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Ok = (response: unknown) => void;

const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));
const hooks = vi.hoisted(() => ({
  auth: { user: { is_staff: true } },
  snackbar: { enqueueSnackbar: vi.fn() },
  translation: { t: (key: string) => key },
}));

vi.mock('../axiosConfig', () => ({
  default: {
    perform_get: (_auth: unknown, url: string, ok: Ok) => ok({ data: api.get(url) }),
    perform_post: (_auth: unknown, url: string, body: unknown, ok: Ok, fail: (error: unknown) => void) =>
      api.post(url, body, ok, fail),
  },
}));
vi.mock('../../hooks/CoreAuthProvider', () => ({ useAuth: () => hooks.auth }));
vi.mock('notistack', () => ({ useSnackbar: () => hooks.snackbar }));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTranslation: () => hooks.translation,
}));
// The charts and the notification panel are not under test here.
vi.mock('../components/ui/kit/DonutChart', () => ({ default: () => null }));
vi.mock('./NotificationLocationsPanel', () => ({ default: () => null }));

const { default: DeviceStatisticsView } = await import('./DeviceStatisticsView');

const LOCATION = (id: number, fields: Record<string, unknown> = {}) => ({
  id,
  database: 'progeo_p1',
  name: `Halle ${id}`,
  project_id: 4700 + id,
  device_count: 0,
  last_measurement_at: null,
  point_count: 0,
  has_points: false,
  has_lageplan: false,
  unused: true,
  dead: true,
  purgeable: null,
  ...fields,
});
const UNUSED = [LOCATION(1), LOCATION(2, { purgeable: true })];

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
  api.get.mockReset();
  api.post.mockReset();
  // The cached snapshot: the overview at once, every section from cache.
  api.get.mockImplementation((url: string) => {
    if (url.includes('plan=1')) {
      return { cached: true, generated_at: '2026-11-16T10:00:00Z', totals: {}, by_type: [] };
    }
    if (url.includes('section=unused_locations') || url.includes('section=dead_locations')) {
      return { locations: { unused_locations: UNUSED, dead_locations: UNUSED } };
    }
    return {};
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = async () => {
  await act(async () => {
    root.render(
      <MemoryRouter>
        <DeviceStatisticsView />
      </MemoryRouter>,
    );
  });
};

const openSection = async (section: string) => {
  await act(async () => {
    container
      .querySelector<HTMLButtonElement>(`[data-testid="device-stats-section-option"][data-test-key="${section}"]`)!
      .click();
  });
};

const toggle = (id: number) =>
  container.querySelector<HTMLButtonElement>(`[data-testid="device-stats-purge-toggle"][data-test-key="progeo_p1-${id}"]`);
const marked = (id: number) =>
  container.querySelector(`[data-testid="device-stats-location-purgeable"][data-test-key="progeo_p1-${id}"]`) != null;

describe('DeviceStatisticsView purgeable locations', () => {
  it('shows the mark per row and the marked rows as switched off', async () => {
    await render();
    await openSection('unused_locations');

    expect(toggle(1)!.textContent).toBe('device_stats_purgeable_mark');
    expect(toggle(2)!.textContent).toBe('device_stats_purgeable_unmark');
    expect(marked(1)).toBe(false);
    expect(marked(2)).toBe(true);
    expect(toggle(2)!.closest('.rdt_TableRow')!.className).toContain('device-stats-row-purgeable');
  });

  it('marks a row and keeps the mark when another list shows the same location', async () => {
    api.post.mockImplementation((_url: string, body: { purgeable: boolean }, ok: Ok) =>
      ok({ data: { location: { id: 1, purgeable: body.purgeable } } }),
    );
    await render();
    await openSection('unused_locations');

    await act(async () => {
      toggle(1)!.click();
    });

    expect(api.post.mock.calls[0].slice(0, 2)).toEqual(['/v1/location/1/purgeable/', { purgeable: true }]);
    expect(marked(1)).toBe(true);
    await openSection('dead_locations');
    expect(marked(1)).toBe(true);
    expect(toggle(1)!.textContent).toBe('device_stats_purgeable_unmark');
  });

  it('offers no purge column for the locations without GPS', async () => {
    api.get.mockImplementation((url: string) =>
      url.includes('plan=1')
        ? { cached: true, totals: {}, by_type: [] }
        : { locations: { locations_without_gps: UNUSED } },
    );
    await render();
    await openSection('locations_without_gps');

    expect(container.querySelector('[data-testid="device-stats-location-link"]')).not.toBeNull();
    expect(toggle(1)).toBeNull();
  });
});
