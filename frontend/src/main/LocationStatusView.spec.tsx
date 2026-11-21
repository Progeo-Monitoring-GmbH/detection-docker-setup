// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocationDetail } from './locationTypes';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

window.matchMedia ??= (query: string) =>
  ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }) as MediaQueryList;

const NOW = Date.now();
const HOUR = 60 * 60 * 1000;

const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  devices: [] as unknown[],
  clusters: [] as unknown[],
  points: [] as unknown[],
  range: null as unknown,
}));
const hooks = vi.hoisted(() => ({
  auth: { user: { is_demo: false } as unknown },
  snackbar: { enqueueSnackbar: vi.fn() },
  translation: {
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  },
  staff: false,
  permissions: new Set<string>(),
}));
// The props the stubbed panels got last.
const panels = vi.hoisted(() => ({
  plan: null as Record<string, unknown> | null,
  zeitreihe: null as Record<string, unknown> | null,
}));

const heatmap = (latest = false) => ({
  data: { '1': [10, 20], '2': [5, 400] },
  timestamps: [(NOW - 2 * HOUR) / 1000, (NOW - HOUR) / 1000],
  step: latest ? null : 1800,
  latest,
  sensor_points: [
    { pos: 1, x: 0.1, y: 0.5, name: 'Nord' },
    { pos: 2, x: 0.2, y: 0.5 },
  ],
});

vi.mock('../axiosConfig', () => ({
  default: {
    perform_get: (_auth: unknown, url: string, ok: (response: unknown) => void) => {
      api.get(url);
      if (url.includes('/request-measurement/devices/')) {
        ok({ data: { devices: api.devices } });
      } else if (url.includes('/measurement-range/')) {
        ok({ data: api.range });
      } else if (url.includes('/heatmap/')) {
        ok({ data: heatmap(url.includes('latest=1')) });
      } else if (url.includes('/alarm/clusters/')) {
        ok({ data: { clusters: api.clusters } });
      } else if (url.includes('/alarm/computed-clusters/')) {
        ok({ data: { points: api.points } });
      } else {
        ok({ data: {} });
      }
    },
    perform_post: (
      _auth: unknown,
      url: string,
      body: unknown,
      ok: (response: unknown) => void,
    ) => {
      api.post(url, body);
      ok({ data: { requested_devices: 1 } });
    },
  },
}));
vi.mock('../../hooks/CoreAuthProvider.tsx', () => ({ useAuth: () => hooks.auth }));
vi.mock('notistack', () => ({ useSnackbar: () => hooks.snackbar }));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTranslation: () => hooks.translation,
}));
vi.mock('./access', () => ({
  useAccess: () => ({
    isStaffOrSuperuser: hooks.staff,
    hasPermission: (key: string) => hooks.permissions.has(key),
  }),
}));
vi.mock('./useLocationLiveRevision', () => ({ useLocationLiveRevision: () => 0 }));
// The panels have their own specs - here only what the page hands them.
vi.mock('./LocationPlanPanel', () => ({
  default: (props: Record<string, unknown>) => {
    panels.plan = props;
    return <div data-testid="stub-plan">{props.frameToolbar as never}</div>;
  },
}));
vi.mock('./ZeitreihePanel', () => ({
  default: (props: Record<string, unknown>) => {
    panels.zeitreihe = props;
    return <div data-testid="stub-zeitreihe" />;
  },
}));
vi.mock('./ComputedSuspicionPanel', () => ({
  default: (props: { headerActions?: unknown }) => (
    <div data-testid="stub-computed">{props.headerActions as never}</div>
  ),
  SuspicionModeSwitch: () => <div data-testid="stub-suspicion-switch" />,
}));
vi.mock('./VerdachtsstellenPanel', () => ({
  default: () => <div data-testid="stub-verdachtsstellen" />,
}));
vi.mock('./LocationBatteryVoltagePanel', () => ({
  default: () => <div data-testid="stub-battery" />,
}));
vi.mock('./LocationClimatePanels', () => ({
  default: () => <div data-testid="stub-climate" />,
}));

const { default: LocationStatusView } = await import('./LocationStatusView');
const { currentStatusView } = await import('./statusViewState');

let container: HTMLDivElement;
let root: Root;

const location = (extra: Partial<LocationDetail> = {}) =>
  ({ id: 4, project_type: 1, alarm_threshold: 250, ...extra }) as LocationDetail;

const render = async (
  path = '/location/4/status',
  props: { location?: LocationDetail; demo?: boolean } = {},
) => {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <LocationStatusView
          location={props.location ?? location()}
          locationId={4}
          demo={props.demo}
        />
      </MemoryRouter>,
    );
  });
};

const byTestId = (id: string) =>
  container.querySelector<HTMLElement>(`[data-testid="${id}"]`);

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  api.get.mockClear();
  api.post.mockClear();
  hooks.snackbar.enqueueSnackbar.mockClear();
  hooks.staff = false;
  hooks.permissions = new Set();
  hooks.auth = { user: { is_demo: false } };
  api.devices = [];
  api.clusters = [];
  api.points = [];
  api.range = {
    first: new Date(NOW - 60 * 24 * HOUR).toISOString(),
    last: new Date(NOW - HOUR).toISOString(),
    count: 100,
    next: null,
  };
  panels.plan = null;
  panels.zeitreihe = null;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('LocationStatusView', () => {
  it('shows the KPIs, the switches and the roof view by default', async () => {
    api.clusters = [
      { id: 'a', sensor_id: 2, state: 'neu', severity: 'alarm', max_value: 412.4, since: null, resolved_at: null },
    ];
    api.points = [{ state: 'neu' }, { state: 'geloest' }];
    await render();

    expect(byTestId('page-location-status')).not.toBeNull();
    expect(byTestId('status-kpis')).not.toBeNull();
    expect(byTestId('status-loading')).toBeNull();
    expect(byTestId('status-switches')).not.toBeNull();
    expect(byTestId('status-view-switch')).not.toBeNull();
    expect(byTestId('status-roof')).not.toBeNull();
    expect(byTestId('stub-computed')).not.toBeNull();
    expect(byTestId('stub-zeitreihe')).toBeNull();
    // The computed points count, not the clusters.
    expect(byTestId('status-kpis')?.textContent).toContain('status_kpi_note_open:{"count":1}');
    expect(byTestId('status-kpis')?.textContent).toContain('412');
    expect(byTestId('status-kpis')?.textContent).toContain('status_kpi_anlage_online');
    expect((byTestId('status-range') as HTMLSelectElement).value).toBe('7d');
    expect(byTestId('status-step')).not.toBeNull();
    expect(panels.plan?.threshold).toBe(250);
    // No request devices, no admin rights: no header.
    expect(byTestId('status-header')).toBeNull();
    expect(currentStatusView(4)).toEqual({ view: 'roof', range: '7d' });
  });

  it('opens what the URL asks for - the Zeitreihe in its range', async () => {
    await render('/location/4/status?view=zeitreihe&range=30d&sensor=2&sensors=sensor-2');

    expect(byTestId('stub-zeitreihe')).not.toBeNull();
    expect(byTestId('status-roof')).toBeNull();
    expect((byTestId('status-range') as HTMLSelectElement).value).toBe('30d');
    expect(panels.zeitreihe?.selectedSensorId).toBe(2);
    expect(panels.zeitreihe?.requestedIds).toEqual(['sensor-2']);
    // The battery chart is staff only.
    expect(byTestId('stub-battery')).toBeNull();
  });

  it('goes to a range reaching back to ?at= and focuses the plan there', async () => {
    const at = new Date(NOW - 20 * 24 * HOUR).toISOString();
    await render(`/location/4/status?range=7d&at=${encodeURIComponent(at)}`);

    expect(byTestId('status-roof')).not.toBeNull();
    expect((byTestId('status-range') as HTMLSelectElement).value).toBe('30d');
    expect(panels.plan?.focusTime).toBe(Date.parse(at));
  });

  it('shows "Letzte Messung" without a step and loads its frames', async () => {
    await render('/location/4/status?range=latest');

    expect((byTestId('status-range') as HTMLSelectElement).value).toBe('latest');
    expect(byTestId('status-step')).toBeNull();
    expect(api.get.mock.calls.some(([url]) => String(url).includes('latest=1'))).toBe(true);
  });

  it('offers the measurement request with a device choice and the admin links to staff', async () => {
    hooks.staff = true;
    hooks.permissions = new Set([
      'module_locations_django_edit',
      'module_locations_django_delete',
    ]);
    api.devices = [
      { id: 7, display_name: 'Dach', chip_id: 'c7', device_ip: '10.0.0.7' },
      { id: 8, display_name: null, label: 'Keller · smartex dm · 8', chip_id: 'c8', device_ip: '10.0.0.8' },
      { id: 9, display_name: 'stumm', chip_id: null, device_ip: '10.0.0.9' },
    ];
    await render();

    expect(byTestId('status-header')).not.toBeNull();
    expect(byTestId('status-django-edit')?.getAttribute('href')).toBe(
      '/aadmin/progeo/progeolocation/4/change/',
    );
    expect(byTestId('status-django-delete')).not.toBeNull();
    const select = byTestId('status-request-device') as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual([
      'Dach',
      'Keller · smartex dm · 8',
    ]);
    expect(byTestId('stub-suspicion-switch')).not.toBeNull();

    await act(async () => {
      select.value = '8';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => {
      byTestId('status-request-measurement')?.click();
    });
    expect(api.post).toHaveBeenCalledWith('/v1/location/4/request-measurement/', { device: 8 });
    expect(hooks.snackbar.enqueueSnackbar).toHaveBeenCalled();
  });

  it('offers no request or admin links to the demo user', async () => {
    hooks.staff = true;
    hooks.permissions = new Set(['module_locations_django_edit']);
    hooks.auth = { user: { is_demo: true } };
    api.devices = [{ id: 7, display_name: 'Dach', chip_id: 'c7', device_ip: '10.0.0.7' }];
    await render();

    expect(byTestId('status-header')).toBeNull();
    expect(api.get.mock.calls.some(([url]) => String(url).includes('request-measurement'))).toBe(false);
  });

  it('shows the climate panels of a LoRaWAN object instead', async () => {
    await render('/location/4/status', { location: location({ project_type: 6 }) });

    expect(byTestId('stub-climate')).not.toBeNull();
    expect(byTestId('status-kpis')).toBeNull();
    expect(byTestId('status-switches')).toBeNull();
    // LoRaWAN has no samples - no history, clusters or measurement range.
    expect(api.get.mock.calls.map(([url]) => String(url))).toEqual([]);
  });

  it('switches to the Zeitreihe and the range keeps going with it', async () => {
    hooks.staff = true;
    await render();

    const zeitreihe = container.querySelector<HTMLElement>(
      '[data-testid^="status-view-switch"][data-test-key="zeitreihe"]',
    );
    expect(zeitreihe).not.toBeNull();
    await act(async () => {
      zeitreihe?.click();
    });
    expect(byTestId('stub-zeitreihe')).not.toBeNull();
    expect(byTestId('stub-battery')).not.toBeNull();

    const range = byTestId('status-range') as HTMLSelectElement;
    await act(async () => {
      range.value = '30d';
      range.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(currentStatusView(4)).toMatchObject({ view: 'zeitreihe', range: '30d' });
  });
});
