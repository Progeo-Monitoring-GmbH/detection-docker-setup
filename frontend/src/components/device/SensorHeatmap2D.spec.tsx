// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SensorHeatmap2D from './SensorHeatmap2D';
import { ownPartTestIds, toolbarHasOwnRow } from './SensorHeatmapParts';
import type { SensorHeatmapResponse } from './sensorHeatmapTypes';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const WIDTH = 800;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // The viewport measures its box; jsdom has no layout and no ResizeObserver.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(WIDTH);
  // jsdom has no canvas: drawing is skipped (sizedContext gets no context).
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  for (const name of ['setPointerCapture', 'releasePointerCapture'] as const) {
    if (!(name in HTMLElement.prototype)) {
      (HTMLElement.prototype as unknown as Record<string, () => void>)[name] =
        () => {};
    }
  }
  if (!('hasPointerCapture' in HTMLElement.prototype)) {
    (
      HTMLElement.prototype as unknown as Record<string, () => boolean>
    ).hasPointerCapture = () => false;
  }
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Two sensors on one horizontal line (no plan image) and three frames. */
const RESPONSE: SensorHeatmapResponse = {
  timestamps: [1_700_000_000, 1_700_000_600, 1_700_001_200],
  data: { '1': [10, 20, 30], '2': [5, 50, 60] },
  sensor_points: [
    {
      pos: 1,
      x: 0.25,
      y: 0.5,
      device: 11,
      name: 'Nord',
      label: 'Fühler Nord',
      threshold: 40,
    },
    {
      pos: 2,
      x: 0.75,
      y: 0.5,
      device: 12,
      name: 'Süd',
      label: 'Fühler Süd',
      disabled: true,
    },
  ],
};

type Props = Parameters<typeof SensorHeatmap2D>[0];

const render = (props: Partial<Props> = {}) => {
  act(() => {
    root.render(
      <SensorHeatmap2D response={RESPONSE} height={400} {...props} />,
    );
  });
};

const byId = (id: string) =>
  container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const canvas = (testId = 'sensor-heatmap') =>
  byId(`${testId}-canvas`) as HTMLCanvasElement;
const plotHeight = (testId = 'sensor-heatmap') =>
  Number.parseFloat(byId(`${testId}-plot`)!.style.height);

const pointer = (
  target: Element,
  type: 'pointermove' | 'pointerdown' | 'pointerup' | 'pointerout',
  x: number,
  y: number,
  init: { shiftKey?: boolean } = {},
) => {
  act(() => {
    target.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        clientX: x,
        clientY: y,
        ...init,
      }) as unknown as PointerEvent,
    );
  });
};

/** Moves along the sensors' line until the tooltip of `pos` shows; its x. */
const findSensor = (pos: number, testId = 'sensor-heatmap') => {
  const target = canvas(testId);
  const y = plotHeight(testId) / 2;
  for (let x = 0; x < WIDTH; x += 3) {
    pointer(target, 'pointermove', x, y);
    if (byId(`${testId}-sensor-tooltip`)?.textContent?.includes(`#${pos}`)) {
      return [x, y] as const;
    }
  }
  throw new Error(`sensor ${pos} not found`);
};

describe('SensorHeatmap2D', () => {
  it('shows the empty state without data, in its card', () => {
    render({ response: null });
    expect(byId('sensor-heatmap')).not.toBeNull();
    expect(byId('sensor-heatmap-empty')?.textContent).toBe(
      'No sensor measurements available.',
    );
    expect(byId('sensor-heatmap-canvas')).toBeNull();
  });

  it('leaves the card out with hideChrome', () => {
    render({ hideChrome: true });
    expect(byId('sensor-heatmap')).toBeNull();
    expect(byId('sensor-heatmap-plot')).not.toBeNull();
  });

  it('renders the plot, the slider, the controls and reports the newest frame', () => {
    const onTimestampChange = vi.fn();
    render({ onTimestampChange });
    expect(byId('sensor-heatmap-plot')?.style.width).toBe(`${WIDTH}px`);
    expect(canvas().className).toBe('heatmap2d-canvas heatmap2d-canvas--grab');
    expect(byId('sensor-heatmap-frame-slider')).not.toBeNull();
    expect(byId('sensor-heatmap-zoom')).not.toBeNull();
    expect(byId('heatmap-display-controls')).not.toBeNull();
    expect(byId('heatmap-display-controls-area')).toBeNull();
    expect(byId('sensor-heatmap-toolbar')).not.toBeNull();
    expect(onTimestampChange).toHaveBeenLastCalledWith(2);
  });

  it('starts at the frame holding focusTime', () => {
    const onTimestampChange = vi.fn();
    render({ onTimestampChange, focusTime: 1_700_000_600 * 1000 });
    expect(onTimestampChange).toHaveBeenLastCalledWith(1);
  });

  it('shows the frame holding `time` when coupled', () => {
    const onTimestampChange = vi.fn();
    render({
      onTimestampChange,
      onTimeChange: vi.fn(),
      time: 1_700_000_000 * 1000,
    });
    expect(onTimestampChange).toHaveBeenLastCalledWith(0);
  });

  it('scopes the parts under another testId', () => {
    render({ testId: 'plan', onAreaSelect: vi.fn() });
    expect(byId('plan')).not.toBeNull();
    expect(byId('plan-canvas')).not.toBeNull();
    expect(byId('plan-display')).not.toBeNull();
    expect(byId('plan-display-area')).not.toBeNull();
    expect(byId('heatmap-display-controls')).toBeNull();
  });

  it('dims the plot while busy', () => {
    render({ busy: true });
    expect(byId('sensor-heatmap-busy')).not.toBeNull();
    expect(byId('sensor-heatmap-plot')?.getAttribute('aria-busy')).toBe('true');
  });

  it('shows a sensor tooltip on hover, reports its device and clicks it', () => {
    const onHoverDevice = vi.fn();
    const onSensorClick = vi.fn();
    render({ onHoverDevice, onSensorClick });
    const [x, y] = findSensor(1);
    expect(onHoverDevice).toHaveBeenLastCalledWith(11);
    expect(canvas().className).toContain('heatmap2d-canvas--pointer');
    const tooltip = byId('sensor-heatmap-sensor-tooltip')!.textContent;
    expect(tooltip).toContain('Sensor #1');
    expect(tooltip).toContain('30');
    expect(tooltip).toContain('40');

    pointer(canvas(), 'pointerdown', x, y);
    pointer(canvas(), 'pointerup', x, y);
    expect(onSensorClick).toHaveBeenCalledWith(1);

    pointer(canvas(), 'pointerout', x, y);
    expect(byId('sensor-heatmap-sensor-tooltip')).toBeNull();
    expect(onHoverDevice).toHaveBeenLastCalledWith(null);
  });

  it('marks a disabled sensor in its tooltip', () => {
    render();
    findSensor(2);
    expect(byId('sensor-heatmap-sensor-tooltip')!.textContent).toContain(
      'disabled',
    );
  });

  it('reads the heat under the cursor off a sensor', () => {
    render();
    const [x, y] = findSensor(1);
    // Between the sensors: no tooltip, the heat in the readout.
    pointer(canvas(), 'pointermove', x + 40, y);
    expect(byId('sensor-heatmap-sensor-tooltip')).toBeNull();
    expect(byId('sensor-heatmap-readout')?.textContent).toMatch(
      /^Heat \d+\.\d{2}$/,
    );
  });

  it('names devices and shows readings with their unit in field mode', () => {
    render({ field: { unit: '%', decimals: 1 } });
    const [x, y] = findSensor(1);
    expect(byId('sensor-heatmap-sensor-tooltip')!.textContent).toContain(
      'Fühler Nord (#1)',
    );
    expect(byId('sensor-heatmap-sensor-tooltip')!.textContent).toContain(
      '30.0 %',
    );
    pointer(canvas(), 'pointermove', x + 40, y);
    expect(byId('sensor-heatmap-readout')?.textContent).toMatch(/^\d+\.\d %$/);
  });

  it('selects the sensors in a Shift-dragged area', () => {
    const onAreaSelect = vi.fn();
    render({ onAreaSelect });
    const [x, y] = findSensor(1);
    pointer(canvas(), 'pointerout', x, y);
    pointer(canvas(), 'pointerdown', x - 20, y - 20, { shiftKey: true });
    pointer(canvas(), 'pointermove', x + 20, y + 20);
    const rect = byId('heatmap-area-rect')!;
    expect([
      rect.style.left,
      rect.style.top,
      rect.style.width,
      rect.style.height,
    ]).toEqual([`${x - 20}px`, `${y - 20}px`, '40px', '40px']);
    pointer(canvas(), 'pointerup', x + 20, y + 20);
    expect(byId('heatmap-area-rect')).toBeNull();
    expect(onAreaSelect).toHaveBeenCalledWith([1]);
  });

  it('turns the cursor into a crosshair in area mode', () => {
    render({ onAreaSelect: vi.fn() });
    act(() => byId('heatmap-display-controls-area')!.click());
    expect(canvas().className).toBe(
      'heatmap2d-canvas heatmap2d-canvas--crosshair',
    );
    expect(canvas().style.touchAction).toBe('none');
  });

  it('enables zoom reset only once zoomed', () => {
    render();
    const reset = byId('sensor-heatmap-zoom-reset') as HTMLButtonElement;
    expect(reset.disabled).toBe(true);
    act(() => byId('sensor-heatmap-zoom-in')!.click());
    expect(
      (byId('sensor-heatmap-zoom-reset') as HTMLButtonElement).disabled,
    ).toBe(false);
    act(() => byId('sensor-heatmap-zoom-reset')!.click());
    expect(
      (byId('sensor-heatmap-zoom-reset') as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe('SensorHeatmapParts helpers', () => {
  it('keeps the own ids of parts with the default heatmap id only', () => {
    expect(ownPartTestIds('sensor-heatmap')).toEqual({
      areaRect: 'heatmap-area-rect',
      display: undefined,
    });
    expect(ownPartTestIds('plan')).toEqual({
      areaRect: 'plan-area-rect',
      display: 'plan-display',
    });
  });

  it('gives the toolbar a row of its own with more than the video export', () => {
    const base = {
      hideFrameSlider: false,
      hasStart: false,
      sigmaEditable: false,
      planCount: 1,
    };
    expect(toolbarHasOwnRow(base)).toBe(false);
    expect(toolbarHasOwnRow({ ...base, hideFrameSlider: true })).toBe(true);
    expect(toolbarHasOwnRow({ ...base, hasStart: true })).toBe(true);
    expect(toolbarHasOwnRow({ ...base, sigmaEditable: true })).toBe(true);
    expect(toolbarHasOwnRow({ ...base, planCount: 2 })).toBe(true);
  });
});
