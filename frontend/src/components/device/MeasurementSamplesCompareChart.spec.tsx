// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Trace = { type?: string; uid?: string; xaxis?: string };

// Plotly needs a real browser: the stand-in keeps the figure it was given.
const figure = vi.hoisted(() => ({ data: [] as Trace[], layout: {} as Record<string, unknown> }));
vi.mock('react-plotly.js', () => ({
  default: (props: { data: Trace[]; layout: Record<string, unknown> }) => {
    figure.data = props.data;
    figure.layout = props.layout;
    return <div data-testid="stub-plot" />;
  },
}));
const translation = vi.hoisted(() => ({
  t: (key: string, options?: Record<string, unknown>) => (options ? `${key}:${JSON.stringify(options)}` : key),
  i18n: { language: 'de' },
}));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTranslation: () => translation,
}));

const { default: MeasurementSamplesCompareChart } = await import('./MeasurementSamplesCompareChart');

/** Three measurements of 4 sensors: samples are [EP, WP] per sensor. Sensor 4 hardly moves. */
const rows = [
  { id: 1, device: 1, last_fetched: '2026-11-01T10:00:00Z', samples: [10, 50, 20, 30, 0, 5, 0, 1] },
  { id: 2, device: 1, last_fetched: '2026-11-01T11:00:00Z', samples: [12, 70, 18, 40, 1, 4, 0, 2] },
  { id: 3, device: 1, last_fetched: '2026-11-01T12:00:00Z', samples: [11, 90, 25, 20, 2, 6, 0, 1] },
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

const byTestId = (id: string) => container.querySelector(`[data-testid="${id}"]`);
const columns = () => [...container.querySelectorAll('[data-testid="measurement-compare-columns-column"]')];

describe('MeasurementSamplesCompareChart', () => {
  it('draws the first plot as one column per sensor - the Plotly figure keeps only the time plots', () => {
    render();

    expect(columns().map((column) => column.getAttribute('data-test-key'))).toEqual(['1', '2', '3', '4']);
    expect(figure.data.every((trace) => trace.xaxis === 'x2' || trace.xaxis === 'x3')).toBe(true);
    expect(figure.layout).not.toHaveProperty('xaxis');
    expect(figure.layout).not.toHaveProperty('yaxis');
  });

  it('shows the period spread without a frame slider too (the alarm view)', () => {
    act(() => {
      root.render(<MeasurementSamplesCompareChart rows={rows} threshold={100} />);
    });

    expect(columns()).toHaveLength(4);
    expect(columns()[0].querySelector('[data-part="sigma"]')).not.toBeNull();
    expect(columns()[0].querySelector('[data-part="ep"]')).toBeNull(); // no measurement picked
  });

  it('shows the spread and the measurement side by side - neither hides the other', () => {
    render();

    const first = columns()[0];
    const sigma = first.querySelector('[data-part="sigma"]')!;
    const ep = first.querySelector('[data-part="ep"]')!;
    const sigmaRight = Number(sigma.getAttribute('x')) + Number(sigma.getAttribute('width'));
    expect(Number(ep.getAttribute('x'))).toBeGreaterThan(sigmaRight);
    expect(first.querySelector('[data-part="minmax"]')).not.toBeNull();
    expect(first.querySelector('[data-part="mean"]')).not.toBeNull();
    expect(first.querySelector('[data-part="wp"]')).not.toBeNull();
  });

  it('follows a clicked sensor in the second plot and tints its column', () => {
    const onSensorsChange = vi.fn();
    render({ sensors: [1], onSensorsChange });

    expect(byTestId('measurement-compare-columns-selected')!.getAttribute('data-test-key')).toBe('1');
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0 } as DOMRect);
    act(() => {
      byTestId('measurement-compare-columns-plot')!.dispatchEvent(
        new MouseEvent('click', { bubbles: true, clientX: 1, clientY: 50 }),
      );
    });
    expect(onSensorsChange).toHaveBeenCalledWith([0, 1]);
  });

  it('switches parts on and off in its legend', () => {
    render();

    act(() => {
      (container.querySelector('[data-testid="measurement-compare-columns-legend"][data-test-key="ep"]') as HTMLElement).click();
    });
    expect(columns()[0].querySelector('[data-part="ep"]')).toBeNull();
    act(() => {
      (container.querySelector('[data-testid="measurement-compare-columns-legend"][data-test-key="sum"]') as HTMLElement).click();
    });
    expect(columns()[0].querySelector('[data-part="sum"]')).not.toBeNull();
  });

  it('draws the masks of a Störungsprofil as outlines over their bars', () => {
    render({ maskLines: { ep: [9, 19, 1, 0], wp: [60, 30, 5, 1] } });

    const mask = columns()[0].querySelector('[data-part="mask-ep"]')!;
    expect(mask.getAttribute('fill')).toBe('none');
    expect(mask.getAttribute('x')).toBe(columns()[0].querySelector('[data-part="ep"]')!.getAttribute('x'));
  });

  it('draws a disabled sensor gray', () => {
    render({ disabledSensors: new Set([2]) });

    const off = columns()[2];
    expect(off.getAttribute('data-disabled')).toBe('true');
    expect(off.querySelector('[data-part="ep"]')!.getAttribute('fill')).toBe('#c9c8c2');
  });

  it('hides the quiet sensors with the grip on the axis - and shows them again', () => {
    render();
    const grip = byTestId('measurement-compare-columns-grip')!;

    // Sensor 4 never goes beyond |WP − EP| = 2: three nudges up hide it.
    act(() => {
      for (let press = 0; press < 3; press += 1) {
        grip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
      }
    });
    expect(columns().map((column) => column.getAttribute('data-test-key'))).toEqual(['1', '2', '3']);
    expect(byTestId('measurement-compare-columns-filter')!.textContent).toContain('"count":1');
    expect(byTestId('measurement-compare-columns-filter-band')).not.toBeNull();

    act(() => {
      (byTestId('measurement-compare-columns-show-all') as HTMLElement).click();
    });
    expect(columns()).toHaveLength(4);
  });

  it('keeps a followed sensor although it is below the level', () => {
    render({ sensors: [3], onSensorsChange: () => {} });
    const grip = byTestId('measurement-compare-columns-grip')!;
    act(() => {
      for (let press = 0; press < 3; press += 1) {
        grip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
      }
    });
    expect(columns().map((column) => column.getAttribute('data-test-key'))).toContain('4');
  });
});
