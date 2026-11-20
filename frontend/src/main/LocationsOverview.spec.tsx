// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// 250 locations: three chunks of details / alarm summaries.
const COUNT = 250;
const recent = new Date(Date.now() - 3600_000).toISOString();
const old = new Date(Date.now() - 10 * 86400_000).toISOString();

const api = vi.hoisted(() => ({
  urls: [] as string[],
  failDetails: false,
  // Set: /min answers only when the test calls it (a slow server).
  heldMin: null as null | (() => void),
  holdMin: false,
}));
// overviewCache in memory (jsdom has no IndexedDB).
const cache = vi.hoisted(() => ({ entries: new Map<string, unknown>() }));
const hooks = vi.hoisted(() => ({
  auth: { user: { is_staff: false, user_id: 5 } as Record<string, unknown>, viewAsUser: false },
  permissions: { hasPermission: () => true, isLoading: false },
  snackbar: { enqueueSnackbar: () => undefined },
  translation: { t: (key: string) => key },
}));

const idsOf = (url: string) =>
  (new URL(url, 'http://x').searchParams.get('ids') ?? '').split(',').filter(Boolean).map(Number);

vi.mock('../axiosConfig', () => ({
  default: {
    perform_get: (_auth: unknown, url: string, ok: (response: unknown) => void, fail: (error: unknown) => void) => {
      api.urls.push(url);
      if (url.startsWith('/v1/location/min/')) {
        const answer = () =>
          ok({
            data: Array.from({ length: COUNT }, (_, index) => ({
              id: index + 1,
              project_id: 1000 + index,
              name: `Objekt ${index + 1}`,
            })),
          });
        if (api.holdMin) {
          api.heldMin = answer;
        } else {
          answer();
        }
      } else if (url.startsWith('/v1/location/details/')) {
        if (api.failDetails) {
          fail(new Error('down'));
        } else {
          ok({
            data: idsOf(url).map((id) => ({
              id,
              measurement_count: 1,
              // Every fifth location has no devices.
              device_count: id % 5 ? 1 : 0,
              // Every third location is offline.
              last_measurement_at: id % 3 ? recent : old,
            })),
          });
        }
      } else if (url.startsWith('/v1/alarm/location_summary/')) {
        ok({ data: { locations: { '7': { count: 2, active: 1 } } } });
      } else {
        ok({ data: {} });
      }
      return Promise.resolve();
    },
  },
}));
vi.mock('./overviewCache', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readOverviewCache: async (key: string | null) => (key ? (cache.entries.get(key) ?? null) : null),
  writeOverviewCache: async (key: string | null, rows: unknown[], alarmSummary: unknown) => {
    if (key) {
      cache.entries.set(key, { version: 1, savedAt: Date.now(), rows, alarmSummary });
    }
  },
}));
vi.mock('../../hooks/CoreAuthProvider', () => ({ useAuth: () => hooks.auth }));
vi.mock('../../hooks/usePermissions', () => ({ default: () => hooks.permissions }));
vi.mock('notistack', () => ({ useSnackbar: () => hooks.snackbar }));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTranslation: () => hooks.translation,
}));

const { default: LocationsOverview, connectedRowFilter, mergeAlarmSummary, refreshRows } = await import(
  './LocationsOverview'
);

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
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
  api.urls = [];
  api.failDetails = false;
  api.holdMin = false;
  api.heldMin = null;
  cache.entries.clear();
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
        <LocationsOverview />
      </MemoryRouter>,
    );
  });
};

const loadingCells = () => container.querySelectorAll('[data-testid$="-loading"]');
const stateTexts = () =>
  Array.from(container.querySelectorAll('[data-testid="locations-state"]')).map((cell) => cell.textContent);

const sortBy = async (label: string) => {
  const header = Array.from(container.querySelectorAll('.rdt_TableCol_Sortable')).find(
    (node) => node.textContent?.includes(label),
  ) as HTMLElement;
  await act(async () => header.click());
};

describe('LocationsOverview loading', () => {
  it('loads every row in chunks in the background - the whole list, not only the first page', async () => {
    await render();

    const detailRequests = api.urls.filter((url) => url.startsWith('/v1/location/details/'));
    expect(detailRequests).toHaveLength(3);
    expect(new Set(detailRequests.flatMap(idsOf)).size).toBe(COUNT);
    expect(container.querySelector('[data-testid="locations-preload"]')).toBeNull();
  });

  it('shows the state of the rows on screen after sorting by it', async () => {
    await render();

    await sortBy('locations_col_state');

    expect(loadingCells()).toHaveLength(0);
    expect(stateTexts().length).toBeGreaterThan(0);
    // Ascending: the offline ones first.
    expect(stateTexts()[0]).toBe('locations_state_offline');

    await sortBy('locations_col_alarm');
    await sortBy('locations_col_alarm');
    expect(loadingCells()).toHaveLength(0);
    expect(container.querySelector('[data-testid="locations-alarm"][data-test-key="7"]')).not.toBeNull();
  });

  it('shows a dash instead of loading forever when the details fail', async () => {
    api.failDetails = true;
    await render();

    expect(container.querySelectorAll('[data-testid="locations-state-loading"]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-testid="locations-state-failed"]').length).toBeGreaterThan(0);
  });
});

const rowTestKeys = () =>
  Array.from(container.querySelectorAll('[data-testid="locations-row"]')).map((cell) =>
    Number(cell.getAttribute('data-test-key')),
  );
const onlyConnectedSwitch = () =>
  container.querySelector('input[data-testid="locations-only-connected"]') as HTMLInputElement;

describe('LocationsOverview filters and cache', () => {
  it('filters by connected devices in the browser - the switch sends no request', async () => {
    await render();
    // Switched on by default: no location without devices (every fifth) is listed.
    expect(rowTestKeys().length).toBeGreaterThan(0);
    expect(rowTestKeys().every((id) => id % 5 !== 0)).toBe(true);
    const requests = api.urls.length;

    await act(async () => onlyConnectedSwitch().click());

    expect(api.urls.length).toBe(requests);
    expect(rowTestKeys()).toContain(5);
  });

  it('shows the cached list at once on a reload and refreshes it in the background', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await render();
      // The loaded list goes to the cache (debounced).
      await act(async () => {
        vi.advanceTimersByTime(1500);
      });
    } finally {
      vi.useRealTimers();
    }
    expect(cache.entries.has('locations-overview:5')).toBe(true);
    act(() => root.unmount());

    // The reload: the server is slow - the cached rows and their state are there already.
    api.holdMin = true;
    api.urls = [];
    root = createRoot(container);
    await render();
    expect(rowTestKeys().length).toBeGreaterThan(0);
    expect(loadingCells()).toHaveLength(0);
    expect(api.urls.filter((url) => url.startsWith('/v1/location/details/'))).toHaveLength(0);

    // The fresh list arrives: state and alarms are refreshed in the background.
    await act(async () => api.heldMin?.());
    expect(api.urls.filter((url) => url.startsWith('/v1/location/details/')).length).toBeGreaterThan(0);
    expect(loadingCells()).toHaveLength(0);
  });

  it("never shows another user's cached list", async () => {
    cache.entries.set('locations-overview:5', {
      version: 1,
      savedAt: Date.now(),
      rows: [{ id: 99, name: 'Fremd', device_count: 1 }],
      alarmSummary: {},
    });
    hooks.auth.user = { is_staff: false, user_id: 6 };
    api.holdMin = true;
    try {
      await render();
      expect(rowTestKeys()).toEqual([]);
    } finally {
      hooks.auth.user = { is_staff: false, user_id: 5 };
    }
  });
});

describe('LocationsOverview list helpers', () => {
  it('replaces the refreshed alarm summaries - an old alarm does not stay', () => {
    const next = mergeAlarmSummary({ '1': { count: 2, active: 1 }, '2': { count: 1, active: 1 } }, {}, [1]);
    expect(next).toEqual({ '1': { count: 0, active: 0 }, '2': { count: 1, active: 1 } });
  });

  it('keeps the known details of a row over a fresh /min list', () => {
    const shown = [{ id: 1, name: 'old', measurement_count: 3, last_measurement_at: recent }, { id: 2, name: 'gone' }];
    expect(refreshRows(shown, [{ id: 1, name: 'new' }, { id: 3, name: 'added' }])).toEqual([
      { id: 1, name: 'new', measurement_count: 3, last_measurement_at: recent },
      { id: 3, name: 'added' },
    ]);
  });

  it('counts a merged project as connected when one of its parts has devices', () => {
    const rows = [
      { id: 1, part_count: 2, device_count: 0 },
      { id: 2, parent_location: 1, device_count: 0 },
      { id: 3, parent_location: 1, device_count: 2 },
      { id: 4, part_count: 1, device_count: 0 },
      { id: 5, parent_location: 4, device_count: 0 },
      { id: 6, device_count: 0 },
      { id: 7 },
    ];
    const connected = connectedRowFilter(rows);
    expect(rows.filter(connected).map((row) => row.id)).toEqual([1, 3, 7]);
  });
});
