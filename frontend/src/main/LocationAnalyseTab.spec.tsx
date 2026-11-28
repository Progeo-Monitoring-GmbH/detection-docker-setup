// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The page's wiring: which requests it makes, what it hands its parts
 * (stubbed - they have specs of their own) and how they talk back.
 */

const outlet = vi.hoisted(() => ({
  value: {
    location: null as unknown,
    locationId: 5,
  },
}));
const translation = vi.hoisted(() => ({ t: (key: string) => key }));
const measurementRange = vi.hoisted(() => ({
  first: '2020-01-01T00:00:00Z',
  last: null,
  count: 1,
}));
const snackbar = vi.hoisted(() => ({ enqueueSnackbar: vi.fn() }));
// Stable per test like the real context - loads depend on it.
const user = vi.hoisted(() => ({ auth: { user: { is_staff: false } } }));
const props = vi.hoisted(() => ({}) as Record<string, Record<string, unknown>>);
const perform = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock('react-router', () => ({
  useOutletContext: () => outlet.value,
  useSearchParams: () => [new URLSearchParams()],
}));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  // Stable like the real one - effects depend on it.
  useTranslation: () => translation,
}));
vi.mock('notistack', () => ({
  useSnackbar: () => snackbar,
}));
vi.mock('../../hooks/CoreAuthProvider.tsx', () => ({
  useAuth: () => user.auth,
}));
vi.mock('../../hooks/usePermissions', () => ({
  default: () => ({ hasPermission: () => true }),
}));
vi.mock('../axiosConfig', () => ({
  default: { perform_get: perform.get, perform_post: perform.post },
}));
const rangeCalls = vi.hoisted(() => [] as unknown[][]);
vi.mock('./useMeasurementRange', () => ({
  default: (...args: unknown[]) => {
    rangeCalls.push(args);
    return measurementRange;
  },
}));
// Plotly needs a canvas - the stubbed parts draw nothing.
vi.mock('react-plotly.js', () => ({ default: () => null }));
vi.mock('plotly.js/dist/plotly', () => ({ default: {} }));
vi.mock('../components/device/useLageplanImage', () => ({
  usePreloadLageplanImages: () => {},
}));

const stub = (name: string) => ({
  default: (componentProps: Record<string, unknown>) => {
    props[name] = componentProps;
    // The frame control of each tab apart (a location with both kinds).
    if ('isSmartexIo' in componentProps) {
      props[`${name}:${componentProps.isSmartexIo ? 'climate' : 'leak'}`] = componentProps;
    }
    return <div data-testid={`stub-${name}`} />;
  },
});
vi.mock('./AnalyseActions', () => stub('actions'));
vi.mock('./AnalyseFrameControl', () => stub('frames'));
vi.mock('./AnalyseHeatmapCard', () => stub('heatmap'));
vi.mock('./AnalyseMeasurementsCard', () => stub('measurements'));
vi.mock('./AnalyseNoisePanel', () => stub('noise'));
vi.mock('../components/device/MeasurementComparePlot', () => stub('compare'));
vi.mock('./LocationClimateHeatmap', () => stub('climateHeatmap'));
vi.mock('./LocationClimatePanels', () => stub('climatePanels'));

const { default: LocationAnalyseTab } = await import('./LocationAnalyseTab');

const HEATMAP = {
  data: { '1': [1, 2], '2': [3, 4] },
  timestamps: [100, 200],
  lageplan: 11,
  location: { alarm_threshold: 50 },
  sensor_points: [
    { pos: 1, x: 0, y: 0, device: 3, pair: 1, threshold: 40 },
    { pos: 2, x: 0, y: 0, device: 3, pair: 2 },
  ],
};
const MEASUREMENTS = {
  measurements: [
    { last_fetched: '1970-01-01T00:02:00Z', samples: [1, 2, 3, 4] },
    { last_fetched: '1970-01-01T00:01:00Z', samples: [1, 2, 3, 4] },
  ],
  total: 2,
  devices: [{ id: 3, display_name: 'Messeinheit 3' }],
  device: 3,
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.keys(props).forEach((key) => delete props[key]);
  perform.get.mockReset();
  perform.post.mockReset();
  perform.get.mockImplementation(
    (_auth: unknown, url: string, done: (response: unknown) => void) => {
      if (url.includes('/heatmap/')) {
        done({ data: HEATMAP });
      } else if (url.includes('/measurements/')) {
        done({ data: MEASUREMENTS });
      } else if (url.includes('/noise-profiles/')) {
        done({ data: { profiles: [] } });
      }
      return Promise.resolve();
    },
  );
  user.auth = { user: { is_staff: false } };
  outlet.value = {
    location: {
      project_id: 7001,
      project_type: 1,
      alarm_threshold: 30,
      lageplans: [
        { id: 11, name: 'EG' },
        { id: 12, name: 'OG' },
      ],
    },
    locationId: 5,
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = () =>
  act(() => {
    root.render(<LocationAnalyseTab />);
  });

const urls = () => perform.get.mock.calls.map((call) => call[1] as string);

describe('LocationAnalyseTab', () => {
  it('loads the heatmap of the first plan and the measurements', () => {
    render();
    expect(
      container.querySelector('[data-testid="page-location-analyse"]'),
    ).not.toBeNull();
    expect(urls()).toContain(
      '/v1/location/5/heatmap/?days=7&limit=300&lageplan=11',
    );
    expect(urls()).toContain('/v1/location/5/measurements/?days=7&limit=300');
    expect(urls().some((url) => url.includes('noise-profiles'))).toBe(false);
  });

  it('hands the loaded data to its parts', () => {
    render();
    expect(props.frames.frameSeconds).toEqual([100, 200]);
    expect(props.frames.frameIndex).toBe(1);
    expect(props.frames.loading).toBe(false);
    expect(props.frames.noiseBadge).toBeNull();
    expect(props.actions.shownDeviceName).toBe('Messeinheit 3');
    expect(props.measurements.shownDevice).toBe(3);
    expect(props.measurements.threshold).toBe(50);
    expect([
      ...(props.measurements.sensorThresholds as Map<number, number>),
    ]).toEqual([[0, 40]]);
    expect(props.measurements.offerSensorHistory).toBe(false);
    expect(props.heatmap.planSwitcher).not.toBeNull();
    expect(props.noise).toBeUndefined();
    expect(props.compare).toBeUndefined();
  });

  it('shows all devices at once - and one again when picked', () => {
    user.auth = { user: { is_staff: true } };
    const devices = [
      { id: 3, display_name: 'Box 3' },
      { id: 4, display_name: 'Box 4' },
    ];
    const rowsOf: Record<string, unknown[]> = {
      // Box 3: two pairs, box 4 one - measured a minute later.
      '3': [{ id: 31, last_fetched: '2026-11-20T10:00:00Z', samples: [0, 1, 0, 2] }],
      '4': [{ id: 41, last_fetched: '2026-11-20T10:01:00Z', samples: [0, 5] }],
    };
    perform.get.mockImplementation(
      (_auth: unknown, url: string, done: (response: unknown) => void) => {
        if (url.includes('/heatmap/')) {
          done({
            data: {
              ...HEATMAP,
              sensor_points: [
                ...HEATMAP.sensor_points,
                { pos: 9, x: 0, y: 0, device: 4, pair: 1 },
              ],
            },
          });
        } else if (url.includes('/measurements/')) {
          const device = /&device=(\d+)/.exec(url)?.[1] ?? '3';
          done({
            data: {
              measurements: rowsOf[device],
              total: 1,
              devices,
              device: Number(device),
              offline:
                device === '4'
                  ? [{ from: '2026-11-18T00:00:00Z', to: '2026-11-19T12:00:00Z' }]
                  : [],
            },
          });
        } else if (url.includes('/noise-profiles/')) {
          done({ data: { profiles: [] } });
        }
        return Promise.resolve();
      },
    );
    render();
    expect(props.measurements.allDevices).toBe(false);
    expect(props.noise).toBeDefined();

    act(() =>
      (props.measurements.onAllDevicesChange as (all: boolean) => void)(true),
    );

    // One request per device - cleaned by the backend, not raw.
    expect(urls()).toContain('/v1/location/5/measurements/?days=7&limit=300&device=3');
    expect(urls()).toContain('/v1/location/5/measurements/?days=7&limit=300&device=4');
    expect(props.measurements.allDevices).toBe(true);
    expect(props.measurements.shownDevice).toBeNull();
    const rows = props.measurements.measurements as { id: number; pair_abs_values: number[] }[];
    expect(rows.map((row) => [row.id, row.pair_abs_values])).toEqual([[41, [1, 2, 5]]]);
    const naming = props.measurements.sensorNaming as { name: (sensor: number) => string };
    expect(naming.name(2)).toBe('Box 4 · measurement_compare_pair_label 1');
    expect(props.frames.offlineSpans).toEqual([
      { from: Date.parse('2026-11-18T00:00:00Z'), to: Date.parse('2026-11-19T12:00:00Z') },
    ]);
    // Profiles and the history are one device's.
    expect(container.querySelector('[data-testid="stub-noise"]')).toBeNull();
    expect(props.measurements.offerSensorHistory).toBe(false);
    // Box 4's sensor on the plan: its pair in the combined rows, no switch.
    act(() => (props.heatmap.onSensorClick as (pos: number) => void)(9));
    expect(props.measurements.sensors).toEqual([2]);
    expect(props.heatmap.selectedPositions).toEqual([9]);

    act(() => (props.measurements.onDeviceChange as (id: number) => void)(4));
    expect(props.measurements.allDevices).toBe(false);
    expect(props.measurements.shownDevice).toBe(4);
    expect(props.measurements.sensorNaming).toBeNull();
    expect(props.measurements.sensors).toEqual([]);
  });

  it('selects sensors clicked on the plan for the second plot', () => {
    render();
    act(() => (props.heatmap.onSensorClick as (pos: number) => void)(2));
    expect(props.measurements.sensors).toEqual([1]);
    expect(props.heatmap.selectedPositions).toEqual([2]);
    expect(props.heatmap.focusedPosition).toBe(2);
  });

  it('steps the frames with the arrow keys and picks plans with 1-9', () => {
    render();
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    });
    expect(props.frames.frameIndex).toBe(0);
    expect(props.heatmap.time).toBe(100_000);
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '2' }));
    });
    expect(props.heatmap.planId).toBe(12);
    expect(urls()).toContain(
      '/v1/location/5/heatmap/?days=7&limit=300&lageplan=12',
    );
  });

  it('loads the comparison of an earlier period', () => {
    render();
    const option = (props.frames.compareOptions as { days: number }[])[0];
    act(() =>
      (props.frames.onCompareChange as (days: number) => void)(option.days),
    );
    expect(props.compare).toBeDefined();
    expect(props.compare.loading).toBe(false);
    expect(urls().filter((url) => url.includes('&to=')).length).toBe(2);
  });

  it('gives staff raw measurements, the profiles and the history', () => {
    user.auth = { user: { is_staff: true } };
    render();
    expect(urls()).toContain(
      '/v1/location/5/measurements/?days=7&limit=300&raw=1',
    );
    expect(urls()).toContain('/v1/location/5/noise-profiles/');
    expect(props.noise).toBeDefined();
    expect(props.measurements.offerSensorHistory).toBe(true);
    expect(
      (props.frames.keyHints as { id?: string }[]).map((hint) => hint.id),
    ).toContain('range-clear');
  });

  it('shows the climate heatmap and charts of smartex io objects', () => {
    outlet.value = {
      location: { project_id: 7002, project_type: 10, lageplans: [] },
      locationId: 6,
    };
    render();
    expect(props.climateHeatmap.locationId).toBe(6);
    expect(props.climatePanels.testId).toBe('analyse-climate-panels');
    expect(props.heatmap).toBeUndefined();
    expect(urls()).toEqual([]);
    act(() =>
      (props.climatePanels.onFramesChange as (frames: number[]) => void)([
        5, 6,
      ]),
    );
    expect(props.frames.frameSeconds).toEqual([5, 6]);
    expect(props.climatePanels.frameTime).toBe(6000);
  });
});

describe('LocationAnalyseTab - leak and climate in one object', () => {
  const mixedLocation = {
    project_id: 7003,
    project_type: 1,
    alarm_threshold: 30,
    lageplans: [{ id: 11, name: 'EG' }],
    device_kinds: ['leak', 'climate'],
  };
  const inPanel = (kind: string, stubName: string) =>
    container.querySelector(
      `[data-testid="analyse-tabs-panel-${kind}"] [data-testid="stub-${stubName}"]`,
    );

  it('shows the tabs - the leak controls only on the leak tab, no climate heatmap', () => {
    outlet.value = { location: mixedLocation, locationId: 5 };
    render();

    expect(container.querySelector('[data-testid="analyse-tabs-tab-leak"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="analyse-tabs-tab-climate"]')).not.toBeNull();
    expect(inPanel('leak', 'actions')).not.toBeNull();
    expect(inPanel('leak', 'heatmap')).not.toBeNull();
    // The climate tab preloaded (hidden): its charts, no heatmap, no exports.
    expect(inPanel('climate', 'climatePanels')).not.toBeNull();
    expect(inPanel('climate', 'actions')).toBeNull();
    expect(props.climateHeatmap).toBeUndefined();
    // The leak heatmap of the leak devices only.
    expect(urls()).toContain('/v1/location/5/heatmap/?days=7&limit=300&lageplan=11&kind=leak');
  });

  it('a new period: the hidden climate tab loads it after the leak tab', () => {
    outlet.value = { location: mixedLocation, locationId: 5 };
    const held: (() => void)[] = [];
    let hold = false;
    perform.get.mockImplementation(
      (_auth: unknown, url: string, done: (response: unknown) => void) => {
        const answer = () => {
          if (url.includes('/heatmap/')) {
            done({ data: HEATMAP });
          } else if (url.includes('/measurements/')) {
            done({ data: MEASUREMENTS });
          }
        };
        if (hold) {
          held.push(answer);
        } else {
          answer();
        }
        return Promise.resolve();
      },
    );
    render();
    expect(props.climatePanels.range).toBe('7d');

    hold = true;
    act(() => (props['frames:leak'].onRangeChange as (range: string) => void)('30d'));
    expect(urls().some((url) => url.includes('heatmap/?days=30'))).toBe(true);
    expect(props.climatePanels.range).toBe('7d');

    act(() => held.splice(0).forEach((answer) => answer()));
    expect(props.climatePanels.range).toBe('30d');
  });

  it('offers the periods the data of the shown tab reaches into', () => {
    outlet.value = { location: mixedLocation, locationId: 5 };
    // useMeasurementRange(locationId, demo, enabled, kind) - asked for:
    const asked = () =>
      rangeCalls.filter((call) => call[2] === true).map((call) => call[3] ?? 'all');
    rangeCalls.length = 0;
    render();
    // Both kinds at once - a switch picks the other one, nothing reloads.
    expect(new Set(asked())).toEqual(new Set(['leak', 'climate']));

    outlet.value = { location: { ...mixedLocation, device_kinds: ['leak'] }, locationId: 5 };
    rangeCalls.length = 0;
    render();
    expect(new Set(asked())).toEqual(new Set(['all']));
  });

  it('a pure leak object shows no tabs', () => {
    outlet.value = {
      location: { ...mixedLocation, device_kinds: ['leak'] },
      locationId: 5,
    };
    render();
    expect(container.querySelector('[data-testid="analyse-tabs-tab-leak"]')).toBeNull();
    expect(urls().some((url) => url.includes('kind='))).toBe(false);
  });
});
