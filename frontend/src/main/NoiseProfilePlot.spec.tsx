// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import NoiseProfilePlot from './NoiseProfilePlot';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, values?: Record<string, unknown>) => (values ? `${key} ${JSON.stringify(values)}` : key) }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let changes: { mask_e: number[]; mask_w: number[] }[];

// jsdom has no layout: the plot sits at 0/0 and is 800 px wide -> 4 sensors
// get 200 px columns. The scale is the highest value (50) x 1.2 = 60 over
// 220 px from y 10: value = (230 - y) / 220 x 60.
const MASK_E = [10, 10, 10, 10];
const MASK_W = [50, 50, 50, 50];
const area = () => container.querySelector<SVGSVGElement>('[data-testid="noise-profile-plot-area"]')!;
const fire = (type: string, x: number, y: number, extra: MouseEventInit = {}) =>
  act(() => {
    area().dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, ...extra }));
  });

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', undefined);
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 800 } as DOMRect);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  changes = [];
  act(() =>
    root.render(<NoiseProfilePlot mask_e={MASK_E} mask_w={MASK_W} onChange={(masks) => changes.push(masks)} />),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('NoiseProfilePlot', () => {
  it('drags the nearer line and paints the sensors crossed - committed once, on release', () => {
    // Sensor 1 near EP (10 -> y 193), dragged to sensor 4 at 30 (y 120).
    fire('pointerdown', 100, 193);
    fire('pointermove', 700, 120);
    expect(changes).toEqual([]);
    fire('pointerup', 700, 120);

    expect(changes).toEqual([{ mask_e: [10, 17, 23, 30], mask_w: MASK_W }]);
  });

  it('moves EP and WP together with Shift', () => {
    fire('pointerdown', 300, 175, { shiftKey: true }); // sensor 2 at 15
    fire('pointerup', 300, 175);

    expect(changes).toEqual([{ mask_e: [10, 15, 10, 10], mask_w: [50, 15, 50, 50] }]);
  });

  it('nudges the last touched value with the arrow keys', () => {
    fire('pointerdown', 500, 65); // sensor 3, near WP (50 -> y 47)
    fire('pointerup', 500, 65);
    const group = container.querySelector<HTMLElement>('[role="group"]')!;
    act(() => {
      group.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', shiftKey: true, bubbles: true }));
    });

    expect(changes[0].mask_w).toEqual([50, 50, 45, 50]);
    // The plot still shows the props (the parent keeps the draft): +10 on 50.
    expect(changes[1].mask_w).toEqual([50, 50, 60, 50]);
  });
});
