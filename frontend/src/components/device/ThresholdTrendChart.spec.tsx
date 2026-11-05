// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ThresholdTrendChart, { TREND_COLORS, type ThresholdTrendSeries } from './ThresholdTrendChart';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const COLORS = TREND_COLORS;
const BASE = Date.UTC(2026, 7, 1, 0, 0, 0);
const iso = (offsetMs: number) => new Date(BASE + offsetMs).toISOString();
const MIN = 60 * 1000;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

const makeSeries = (
  id: string,
  values: Array<[number, number | null]>,
  threshold: number | null = 100,
): ThresholdTrendSeries => ({
  id,
  label: `Sensor ${id}`,
  threshold,
  points: values.map(([offset, value], index) => ({
    id: `${id}-${index}`,
    triggered_at: iso(offset),
    value,
  })),
});

const renderChart = (
  series: ThresholdTrendSeries[],
  overrides: Partial<{
    hiddenSeries: Set<string>;
    onToggleSeries: (id: string) => void;
    meanOfLabel: (count: number) => string;
    highlightedId: string | null;
    onHighlight: (id: string | null) => void;
  }> = {},
) => {
  const props = {
    hiddenSeries: new Set<string>(),
    onToggleSeries: vi.fn(),
    meanOfLabel: (count: number) => `mean of ${count}`,
    highlightedId: null as string | null,
    onHighlight: vi.fn(),
    ...overrides,
  };
  act(() => {
    root.render(
      <ThresholdTrendChart
        series={series}
        hiddenSeries={props.hiddenSeries}
        onToggleSeries={props.onToggleSeries}
        emptyLabel="No data"
        meanOfLabel={props.meanOfLabel}
        thresholdLabel="Threshold (1x)"
        highlightedId={props.highlightedId}
        onHighlight={props.onHighlight}
      />,
    );
  });
  return props;
};

const polylines = () => Array.from(container.querySelectorAll('svg polyline'));
const legendButtons = () => Array.from(container.querySelectorAll('button'));
// The plot is the first <svg>; the legend swatches are rendered after it.
const plotSvg = () => {
  const svg = container.querySelector<SVGSVGElement>('svg')!;
  expect(svg.getAttribute('viewBox')).toBe('0 0 1000 180');
  return svg;
};
const svgTexts = () => Array.from(plotSvg().querySelectorAll('text')).map((node) => node.textContent);

describe('ThresholdTrendChart empty state', () => {
  it('shows the empty label without any series', () => {
    renderChart([]);
    expect(container.textContent).toBe('No data');
    expect(container.querySelector('svg')).toBeNull();
  });

  it('shows the empty label when no point has both a time and a value', () => {
    renderChart([
      {
        id: 'a',
        label: 'A',
        threshold: 100,
        points: [
          { id: 1, triggered_at: null, value: 120 },
          { id: 2, triggered_at: iso(0), value: null },
        ],
      },
    ]);
    expect(container.textContent).toBe('No data');
  });
});

describe('ThresholdTrendChart rendering', () => {
  it('draws one polyline per visible series with colours in pool order', () => {
    renderChart([
      makeSeries('a', [[0, 50], [60 * MIN, 150]]),
      makeSeries('b', [[0, 80], [60 * MIN, 120]]),
    ]);
    const lines = polylines();
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => line.getAttribute('stroke'))).toEqual([COLORS[0], COLORS[1]]);
    lines.forEach((line) => expect(line.hasAttribute('stroke-dasharray')).toBe(false));
  });

  it('renders a legend entry per series plus the threshold legend entry', () => {
    renderChart([makeSeries('a', [[0, 50]]), makeSeries('b', [[0, 80]])]);
    expect(legendButtons().map((button) => button.textContent)).toEqual(['Sensor a', 'Sensor b']);
    expect(container.textContent).toContain('Threshold (1x)');
  });

  it('drops series without valid points from both the plot and the legend', () => {
    renderChart([makeSeries('a', [[0, 50]]), makeSeries('empty', [[0, null]])]);
    expect(polylines()).toHaveLength(1);
    expect(legendButtons().map((button) => button.textContent)).toEqual(['Sensor a']);
  });

  it('repeats the colour pool beyond its size - never dashed', () => {
    const count = COLORS.length + 2;
    const series = Array.from({ length: count }, (_, index) => makeSeries(`s${index}`, [[0, 50 + index]]));
    renderChart(series);
    const lines = polylines();
    expect(lines).toHaveLength(count);
    expect(lines[COLORS.length].getAttribute('stroke')).toBe(COLORS[0]);
    expect(lines[COLORS.length + 1].getAttribute('stroke')).toBe(COLORS[1]);
    expect(container.querySelectorAll('[stroke-dasharray]')).toHaveLength(0);
  });

  it('takes a colour given with the series', () => {
    renderChart([{ ...makeSeries('a', [[0, 50]]), color: '#123456' }]);
    expect(polylines()[0].getAttribute('stroke')).toBe('#123456');
  });

  it('draws the 1x threshold line solid', () => {
    renderChart([makeSeries('a', [[0, 50]])]);
    expect(plotSvg().querySelectorAll('line[stroke-dasharray]')).toHaveLength(0);
  });

  it('labels the y axis with 0x, 1x and 1.15x the max ratio', () => {
    // max ratio = 200 / 100 = 2 -> top tick 2.3x
    renderChart([makeSeries('a', [[0, 50], [60 * MIN, 200]])]);
    expect(svgTexts()).toEqual(expect.arrayContaining(['0.00x', '1.00x', '2.30x']));
  });

  it('keeps 1x visible (top tick 1.15x) when all readings are below the threshold', () => {
    renderChart([makeSeries('a', [[0, 10], [60 * MIN, 20]])]);
    expect(svgTexts()).toEqual(expect.arrayContaining(['0.00x', '1.00x', '1.15x']));
  });

  it('formats ratios >= 10 without decimals', () => {
    // max ratio 20 -> top tick 23x
    renderChart([makeSeries('a', [[0, 2000]])]);
    expect(svgTexts()).toContain('23x');
  });

  it('plots values relative to each series threshold', () => {
    // Both readings are exactly 2x their own threshold -> same y.
    renderChart([makeSeries('a', [[0, 200]], 100), makeSeries('b', [[0, 50]], 25)]);
    const [a, b] = polylines().map((line) => line.getAttribute('points'));
    expect(a).toBe(b);
  });

  it('treats a missing or non-positive threshold as 1', () => {
    renderChart([makeSeries('a', [[0, 3]], null), makeSeries('b', [[0, 3]], 0), makeSeries('c', [[0, 3]], 1)]);
    const [a, b, c] = polylines().map((line) => line.getAttribute('points'));
    expect(a).toBe(c);
    expect(b).toBe(c);
  });

  it('centres a single point (zero time range) horizontally', () => {
    renderChart([makeSeries('a', [[0, 100]])]);
    const circle = plotSvg().querySelector('circle')!;
    expect(Number(circle.getAttribute('cx'))).toBe(515);
  });
});

describe('ThresholdTrendChart clustering', () => {
  it('merges near-simultaneous points into one mean point - a line, no dots', () => {
    // range = 90 min -> merge window = 1 min; the first two points are 10s apart.
    renderChart([makeSeries('a', [[0, 100], [10 * 1000, 300], [90 * MIN, 100]])]);
    expect(polylines()[0].getAttribute('points')!.split(' ')).toHaveLength(2);
    expect(plotSvg().querySelectorAll('circle')).toHaveLength(0);
  });

  it('keeps points further apart than the merge window separate', () => {
    renderChart([makeSeries('a', [[0, 100], [30 * MIN, 120], [60 * MIN, 140], [90 * MIN, 100]])]);
    expect(polylines()[0].getAttribute('points')!.split(' ')).toHaveLength(4);
  });

  it('sorts points by time before drawing', () => {
    renderChart([makeSeries('a', [[90 * MIN, 100], [0, 100], [45 * MIN, 100]])]);
    const xs = polylines()[0]
      .getAttribute('points')!
      .split(' ')
      .map((pair) => Number(pair.split(',')[0]));
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    expect(xs[0]).toBe(40);
    expect(xs[2]).toBe(990);
  });
});

describe('ThresholdTrendChart legend interaction', () => {
  it('calls onToggleSeries with the series id', () => {
    const { onToggleSeries } = renderChart([makeSeries('a', [[0, 50]]), makeSeries('b', [[0, 80]])]);
    act(() => legendButtons()[1].click());
    expect(onToggleSeries).toHaveBeenCalledWith('b');
  });

  it('hides hidden series from the plot but keeps them greyed out in the legend', () => {
    renderChart([makeSeries('a', [[0, 50]]), makeSeries('b', [[0, 80]])], {
      hiddenSeries: new Set(['a']),
    });
    const lines = polylines();
    expect(lines).toHaveLength(1);
    expect(lines[0].getAttribute('stroke')).toBe(COLORS[1]);
    expect(legendButtons()).toHaveLength(2);
    expect(legendButtons()[0].querySelector('line')!.getAttribute('stroke')).toBe('#B8B0B0');
  });

  it('keeps the colour assignment stable when a series is hidden', () => {
    renderChart([makeSeries('a', [[0, 50]]), makeSeries('b', [[0, 80]]), makeSeries('c', [[0, 90]])], {
      hiddenSeries: new Set(['b']),
    });
    expect(polylines().map((line) => line.getAttribute('stroke'))).toEqual([COLORS[0], COLORS[2]]);
  });
});

describe('ThresholdTrendChart hover tooltip', () => {
  const hoverAt = (clientX: number) => {
    const svg = plotSvg();
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 1000, height: 180 } as DOMRect);
    act(() => {
      svg.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX, clientY: 50 }));
    });
  };

  it('shows the nearest point with label and ratio', () => {
    renderChart([makeSeries('a', [[0, 100], [90 * MIN, 250]])]);
    hoverAt(980);
    expect(container.textContent).toContain('Sensor a');
    expect(container.textContent).toContain('2.50x');
  });

  it('shows the "mean of" label for merged points', () => {
    renderChart([makeSeries('a', [[0, 100], [10 * 1000, 300], [90 * MIN, 100]])]);
    hoverAt(41);
    expect(container.textContent).toContain('(mean of 2)');
    expect(container.textContent).toContain('2.00x');
  });

  it('hides the tooltip outside the plot area and on mouse leave', () => {
    renderChart([makeSeries('a', [[0, 100], [90 * MIN, 250]])]);
    hoverAt(980);
    expect(container.textContent).toContain('2.50x');
    hoverAt(5);
    expect(container.textContent).not.toContain('2.50x');

    hoverAt(980);
    act(() => {
      plotSvg().dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
    });
    expect(container.textContent).not.toContain('2.50x');
  });
});

describe('ThresholdTrendChart highlighting', () => {
  const opacityOf = (id: string) =>
    container.querySelector(`[data-series="${id}"] polyline`)!.getAttribute('stroke-opacity');

  it('fades every other line while one is highlighted', () => {
    renderChart([makeSeries('a', [[0, 50], [MIN, 60]]), makeSeries('b', [[0, 80], [MIN, 90]])], {
      highlightedId: 'b',
    });
    expect(opacityOf('b')).toBe('1');
    expect(opacityOf('a')).toBe('0.18');
    expect(container.querySelector('[data-series="b"] polyline')!.getAttribute('stroke-width')).toBe('3.2');
    // Drawn last: on top of the others.
    expect(polylines()[1].getAttribute('stroke')).toBe(COLORS[1]);
  });

  it('ignores a highlight of a series it does not plot', () => {
    renderChart([makeSeries('a', [[0, 50], [MIN, 60]])], { highlightedId: 'nope' });
    expect(opacityOf('a')).toBe('1');
  });

  it('draws a preview series without a legend entry', () => {
    renderChart([makeSeries('a', [[0, 50]]), { ...makeSeries('p', [[0, 80]]), preview: true }]);
    expect(polylines()).toHaveLength(2);
    expect(legendButtons().map((button) => button.textContent)).toEqual(['Sensor a']);
  });

  it('reports the hovered legend entry', () => {
    const { onHighlight } = renderChart([makeSeries('a', [[0, 50]]), makeSeries('b', [[0, 80]])]);
    act(() => {
      legendButtons()[1].dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(onHighlight).toHaveBeenLastCalledWith('b');
    act(() => {
      legendButtons()[1].dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
    });
    expect(onHighlight).toHaveBeenLastCalledWith(null);
  });

  it('reports the line nearest to the cursor in height, not the first one', () => {
    const { onHighlight } = renderChart([
      makeSeries('low', [[0, 10], [90 * MIN, 10]]),
      makeSeries('high', [[0, 300], [90 * MIN, 300]]),
    ]);
    const svg = plotSvg();
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 1000, height: 180 } as DOMRect);
    act(() => {
      svg.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 980, clientY: 20 }));
    });
    expect(container.textContent).toContain('Sensor high');
    expect(onHighlight).toHaveBeenLastCalledWith('high');
    act(() => {
      svg.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 980, clientY: 145 }));
    });
    expect(container.textContent).toContain('Sensor low');
    expect(onHighlight).toHaveBeenLastCalledWith('low');
  });
});
