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
  // The history (heatmap): answered with this status - held back (`held`)
  // while `hold` is on, to look at the page before it arrives.
  heatmapStatus: 200,
  hold: false,
  held: [] as (() => void)[],
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
  climate: null as Record<string, unknown> | null,
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
    perform_get: (
      _auth: unknown,
      url: string,
      ok: (response: unknown) => void,
      fail?: (error: unknown) => void,
    ) => {
      api.get(url);
      if (url.includes('/request-measurement/devices/')) {
        ok({ data: { devices: api.devices } });
      } else if (url.includes('/measurement-range/')) {
        ok({ data: api.range });
      } else if (url.includes('/heatmap/')) {
        const answer = () =>
          api.heatmapStatus === 200
            ? ok({ data: heatmap(url.includes('latest=1')) })
            : fail?.({ response: { status: api.heatmapStatus } });
        if (api.hold) {
          api.held.push(answer);
        } else {
          answer();
        }
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
// The socket: `arrive` announces new measurements as useLocationLiveRevision
// does - the revision of their kind goes up and the page's callback runs.
type LiveKind = 'leak' | 'climate';
type LiveCallback = (m: { count: number | null; alarm: boolean; kind: LiveKind }) => void;
const live = vi.hoisted(() => ({
  revisions: { leak: 0, climate: 0 },
  kinds: [] as readonly string[],
  onMeasurements: null as null | LiveCallback,
}));
vi.mock('./useLocationLiveRevision', () => ({
  NO_LIVE_REVISIONS: { leak: 0, climate: 0 },
  useLocationLiveRevision: (
    _locationId: number,
    kinds: readonly string[],
    onMeasurements?: LiveCallback,
  ) => {
    live.kinds = kinds;
    live.onMeasurements = onMeasurements ?? null;
    return live.revisions;
  },
}));
// The page last rendered - rendered again when the (mocked) revision goes up,
// as the real hook's state update does.
let rendered: (() => React.ReactElement) | null = null;
const arrive = async (count: number | null = 1, alarm = false, kind: LiveKind = 'leak') => {
  await act(async () => {
    live.revisions = { ...live.revisions, [kind]: live.revisions[kind] + 1 };
    live.onMeasurements?.({ count, alarm, kind });
    if (rendered) {
      root.render(rendered());
    }
  });
};
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
  default: (props: Record<string, unknown>) => {
    panels.climate = props;
    return <div data-testid="stub-climate" />;
  },
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
  const shown = props.location ?? location();
  rendered = () => (
    <MemoryRouter initialEntries={[path]}>
      <LocationStatusView location={shown} locationId={4} demo={props.demo} />
    </MemoryRouter>
  );
  const page = rendered();
  await act(async () => {
    root.render(page);
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
  live.revisions = { leak: 0, climate: 0 };
  live.kinds = [];
  live.onMeasurements = null;
  rendered = null;
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
  panels.climate = null;
  api.heatmapStatus = 200;
  api.hold = false;
  api.held = [];
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
    // No request devices: no header.
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

  it('jumps to "Letzte Messung" when new measurements arrive and reloads them', async () => {
    hooks.permissions = new Set(['module_locations_enabled', 'module_measurements_enabled']);
    await render('/location/4/status?view=zeitreihe&range=30d');
    expect((byTestId('status-range') as HTMLSelectElement).value).toBe('30d');
    api.get.mockClear();

    await arrive(2);

    expect((byTestId('status-range') as HTMLSelectElement).value).toBe('latest');
    expect(api.get.mock.calls.some(([url]) => String(url).includes('latest=1'))).toBe(true);
    expect(api.get.mock.calls.some(([url]) => String(url).includes('/measurement-range/'))).toBe(true);
    expect(hooks.snackbar.enqueueSnackbar).toHaveBeenCalledWith(
      'status_live_measurement:{"count":2}',
      { variant: 'info' },
    );
  });

  it('staff jump to "Letzte Messung" without the module permission (the backend lets them in)', async () => {
    hooks.staff = true;
    await render();

    await arrive();

    expect((byTestId('status-range') as HTMLSelectElement).value).toBe('latest');
  });

  it('only tells new measurements to a user who may not see them - no reload, no 403 toast', async () => {
    // The status page needs module_locations_enabled, its measurement data
    // module_measurements_enabled: a reload would be refused (an error toast
    // per measurement).
    hooks.permissions = new Set(['module_locations_enabled']);
    await render();
    api.get.mockClear();

    await arrive(1, true);

    expect(api.get).not.toHaveBeenCalled();
    expect((byTestId('status-range') as HTMLSelectElement).value).toBe('7d');
    expect(hooks.snackbar.enqueueSnackbar).toHaveBeenCalledTimes(1);
    expect(hooks.snackbar.enqueueSnackbar).toHaveBeenCalledWith(
      'status_live_measurement_alarm:{"count":1}',
      { variant: 'warning' },
    );
  });

  it('offers the measurement request with a device choice - the admin links are in the portal header', async () => {
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
    // Moved to the portal header (LocationAdminActions).
    expect(byTestId('status-django-edit')).toBeNull();
    expect(byTestId('status-django-delete')).toBeNull();
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

  it('shows the climate panels of a smartex io object instead', async () => {
    await render('/location/4/status', { location: location({ project_type: 10 }) });

    expect(byTestId('stub-climate')).not.toBeNull();
    expect(byTestId('status-kpis')).toBeNull();
    expect(byTestId('status-switches')).toBeNull();
    // smartex io has no samples - no history, clusters or measurement range.
    expect(api.get.mock.calls.map(([url]) => String(url))).toEqual([]);
  });

  it('shows a pure leak object without tabs, asking as before (no ?kind=)', async () => {
    hooks.permissions = new Set(['module_locations_enabled', 'module_measurements_enabled']);
    await render('/location/4/status', { location: location({ device_kinds: ['leak'] }) });

    expect(byTestId('status-tabs-tab-leak')).toBeNull();
    expect(byTestId('stub-climate')).toBeNull();
    expect(api.get.mock.calls.some(([url]) => String(url).includes('kind='))).toBe(false);
    expect(live.kinds).toEqual(['leak']);
  });

  it('a pure smartex io object: no tabs, no live updates', async () => {
    await render('/location/4/status', {
      location: location({ project_type: 10, device_kinds: ['climate'] }),
    });

    expect(byTestId('status-tabs-tab-climate')).toBeNull();
    expect(byTestId('stub-climate')).not.toBeNull();
    expect(live.kinds).toEqual([]);
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

describe('LocationStatusView - leak and climate in one object', () => {
  const mixed = () => location({ device_kinds: ['leak', 'climate'] });
  const PERMS = ['module_locations_enabled', 'module_measurements_enabled'];

  it('shows the tabs, leak first - the climate tab loads hidden once the leak history is there', async () => {
    hooks.permissions = new Set(PERMS);
    api.hold = true;
    await render('/location/4/status', { location: mixed() });

    expect(byTestId('status-tabs-tab-leak')).not.toBeNull();
    expect(byTestId('status-tabs-tab-climate')).not.toBeNull();
    expect(byTestId('status-tabs-panel-leak')?.hidden).toBe(false);
    expect(byTestId('stub-climate')).toBeNull();
    // The leak tab asks for the leak devices only.
    expect(api.get.mock.calls.some(([url]) => /measurement-range\/\?kind=leak/.test(String(url)))).toBe(true);

    await act(async () => {
      api.held.splice(0).forEach((answer) => answer());
    });

    expect(byTestId('stub-climate')).not.toBeNull();
    expect(byTestId('status-tabs-panel-climate')?.hidden).toBe(true);
    expect(panels.climate?.kind).toBe('climate');
    expect(live.kinds).toEqual(['leak', 'climate']);
  });

  it('preloads the climate tab also when the leak history is refused', async () => {
    hooks.permissions = new Set(PERMS);
    api.heatmapStatus = 403;
    await render('/location/4/status', { location: mixed() });

    expect(byTestId('stub-climate')).not.toBeNull();
  });

  it('an escalation takes the shown tab along', async () => {
    hooks.permissions = new Set(PERMS);
    await render('/location/4/status', { location: mixed() });
    expect(currentStatusView(4)?.tab).toBeUndefined();

    await act(async () => {
      byTestId('status-tabs-tab-climate')?.click();
    });
    expect(currentStatusView(4)?.tab).toBe('climate');
  });

  it('opens the tab the URL asks for', async () => {
    hooks.permissions = new Set(PERMS);
    await render('/location/4/status?tab=climate', { location: mixed() });

    expect(byTestId('status-tabs-panel-climate')?.hidden).toBe(false);
    // The leak tab waits until the climate one is there - nothing loaded yet.
    expect(byTestId('status-tabs-panel-leak')).toBeNull();
    expect(api.get.mock.calls.some(([url]) => String(url).includes('/heatmap/'))).toBe(false);

    await act(async () => {
      (panels.climate?.onReady as () => void)();
    });
    expect(byTestId('status-tabs-panel-leak')?.hidden).toBe(true);
    expect(api.get.mock.calls.some(([url]) => String(url).includes('/heatmap/?'))).toBe(true);
  });

  it('climate news reload the climate tab only - leak news jump to "Letzte Messung"', async () => {
    hooks.permissions = new Set(PERMS);
    await render('/location/4/status?range=30d', { location: mixed() });
    expect(panels.climate?.revision).toBe(0);

    await arrive(1, false, 'climate');
    expect(panels.climate?.revision).toBe(1);
    expect((byTestId('status-range') as HTMLSelectElement).value).toBe('30d');

    await arrive(1, false, 'leak');
    expect((byTestId('status-range') as HTMLSelectElement).value).toBe('latest');
    expect(panels.climate?.revision).toBe(1);
  });

  it('without the measurement permission: only toasts, in no tab a reload', async () => {
    hooks.permissions = new Set(['module_locations_enabled']);
    await render('/location/4/status', { location: mixed() });
    api.get.mockClear();

    await arrive(1, false, 'leak');
    await arrive(1, false, 'climate');

    expect(api.get).not.toHaveBeenCalled();
    expect(panels.climate?.revision ?? 0).toBe(0);
    expect((byTestId('status-range') as HTMLSelectElement).value).toBe('7d');
    expect(hooks.snackbar.enqueueSnackbar).toHaveBeenCalledTimes(2);
  });
});
