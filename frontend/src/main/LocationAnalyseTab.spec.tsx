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
vi.mock('./useMeasurementRange', () => ({
  default: () => measurementRange,
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

  it('shows the climate heatmap and charts of LoRaWAN objects', () => {
    outlet.value = {
      location: { project_id: 7002, project_type: 6, lageplans: [] },
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
