// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Trace = {
  type?: string;
  uid?: string;
  xaxis?: string;
  x?: number[];
  y?: number[];
  base?: number[];
  width?: number;
  offset?: number;
  marker?: { color?: string; line?: { color?: string } };
};

// Plotly needs a real browser: the stand-in keeps the figure it was given.
const figure = vi.hoisted(() => ({ data: [] as Trace[] }));
vi.mock('react-plotly.js', () => ({
  default: (props: { data: Trace[] }) => {
    figure.data = props.data;
    return <div data-testid="stub-plot" />;
  },
}));
const translation = vi.hoisted(() => ({ t: (key: string) => key, i18n: { language: 'de' } }));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTranslation: () => translation,
}));

const { default: MeasurementSamplesCompareChart, currentBarSlots } = await import('./MeasurementSamplesCompareChart');

/** Three measurements of 3 sensors: samples are [EP, WP] per sensor. */
const rows = [
  { id: 1, device: 1, last_fetched: '2026-11-01T10:00:00Z', samples: [10, 50, 20, 30, 0, 5] },
  { id: 2, device: 1, last_fetched: '2026-11-01T11:00:00Z', samples: [12, 70, 18, 40, 1, 4] },
  { id: 3, device: 1, last_fetched: '2026-11-01T12:00:00Z', samples: [11, 90, 25, 20, 2, 6] },
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const render = (props: Record<string, unknown> = {}) =>
  act(() => {
    root.render(<MeasurementSamplesCompareChart rows={rows} frameSlider threshold={100} {...props} />);
  });

/** The first plot's traces: the ones on the default axes. */
const firstPlot = () => figure.data.filter((trace) => !trace.xaxis);
const byUid = (uid: string) => figure.data.find((trace) => trace.uid === uid)!;

describe('MeasurementSamplesCompareChart - the first plot', () => {
  it('draws every sensor value as a bar - no line connects two sensors', () => {
    render();

    const drawn = firstPlot().filter((trace) => trace.uid !== 'threshold-area'); // a layout shape's legend entry
    expect(drawn.map((trace) => trace.uid).sort()).toEqual(['deviation', 'ep', 'mean', 'min-max', 'wp', 'wp+ep']);
    expect(drawn.every((trace) => trace.type === 'bar')).toBe(true);
  });

  it('draws the spread as boxes from low to high and the mean as a flat bar on them', () => {
    render();

    const minMax = byUid('min-max');
    // Sensor 1 reads WP - EP = 40, 58, 79 over the period.
    expect(minMax.base![0]).toBe(40);
    expect(minMax.y![0]).toBe(39);
    const mean = byUid('mean');
    const meanValue = (40 + 58 + 79) / 3;
    expect(mean.base![0] + mean.y![0] / 2).toBeCloseTo(meanValue);
    expect(mean.y![0]).toBeLessThan(5); // a tick, not a column
    expect(mean.width).toBe(minMax.width);
  });

  it("shows the slider's measurement as EP and WP bars side by side in the sensor's slot", () => {
    render();

    const ep = byUid('ep');
    const wp = byUid('wp');
    expect(ep.x).toEqual([1, 2, 3]);
    expect(ep.offset! + ep.width!).toBeLessThanOrEqual(wp.offset!); // no overlap
    expect(ep.marker?.color).toBe('red');
    expect(wp.marker?.color).toBe('blue');
  });

  it('draws the masks of a Störungsprofil as outlined bars over their EP / WP bar', () => {
    render({ maskLines: { ep: [9, 19, 1], wp: [60, 30, 5] } });

    const maskEp = byUid('mask-ep');
    expect(maskEp.type).toBe('bar');
    expect([maskEp.offset, maskEp.width]).toEqual([byUid('ep').offset, byUid('ep').width]);
    expect(maskEp.marker?.line?.color).toBe('red');
    expect(maskEp.marker?.color).toBe('rgba(0, 0, 0, 0)');
  });
});

describe('currentBarSlots', () => {
  it.each([false, true])('keeps the bars apart and inside the spread box (with WP + EP: %s)', (withSum) => {
    const slots = currentBarSlots(withSum);
    const shown = withSum ? (['ep', 'wp', 'wp+ep'] as const) : (['ep', 'wp'] as const);
    const spans = shown.map((key) => [slots[key], slots[key] + slots.width]);
    spans.forEach(([from, to], index) => {
      expect(from).toBeGreaterThanOrEqual(-0.42);
      expect(to).toBeLessThanOrEqual(0.42);
      if (index > 0) {
        expect(from).toBeGreaterThanOrEqual(spans[index - 1][1]);
      }
    });
  });
});
