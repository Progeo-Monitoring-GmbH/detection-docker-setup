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

const api = vi.hoisted(() => ({ urls: [] as string[], failDetails: false }));
const hooks = vi.hoisted(() => ({
  auth: { user: { is_staff: false } },
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
        ok({
          data: Array.from({ length: COUNT }, (_, index) => ({
            id: index + 1,
            project_id: 1000 + index,
            name: `Objekt ${index + 1}`,
          })),
        });
      } else if (url.startsWith('/v1/location/details/')) {
        if (api.failDetails) {
          fail(new Error('down'));
        } else {
          ok({
            data: idsOf(url).map((id) => ({
              id,
              measurement_count: 1,
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
vi.mock('../../hooks/CoreAuthProvider', () => ({ useAuth: () => hooks.auth }));
vi.mock('../../hooks/usePermissions', () => ({ default: () => hooks.permissions }));
vi.mock('notistack', () => ({ useSnackbar: () => hooks.snackbar }));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTranslation: () => hooks.translation,
}));

const { default: LocationsOverview } = await import('./LocationsOverview');

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
