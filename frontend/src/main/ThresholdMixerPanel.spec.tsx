// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MixerSensor } from './thresholdMixer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  sensors: [] as MixerSensor[],
  get: vi.fn(),
  patch: vi.fn(),
  post: vi.fn(),
}));

vi.mock('../axiosConfig', () => ({
  default: {
    perform_get: (_auth: unknown, url: string, ok: (response: unknown) => void) => {
      api.get(url);
      ok({ data: { sensors: api.sensors } });
    },
    perform_patch: (_auth: unknown, url: string, body: unknown, ok: (response: unknown) => void) => {
      api.patch(url, body);
      ok({ data: {} });
    },
    perform_post: (_auth: unknown, url: string, body: unknown, ok: (response: unknown) => void) => {
      api.post(url, body);
      ok({ data: {} });
    },
  },
}));
// Stable like the real hooks' values (load() depends on them).
const hooks = vi.hoisted(() => ({ auth: {}, snackbar: { enqueueSnackbar: () => undefined } }));
vi.mock('../../hooks/CoreAuthProvider.tsx', () => ({ useAuth: () => hooks.auth }));
vi.mock('notistack', () => ({ useSnackbar: () => hooks.snackbar }));
// A stable t, like react-i18next's.
const translation = vi.hoisted(() => ({
  t: (key: string, options?: Record<string, unknown>) => (options ? `${key}:${JSON.stringify(options)}` : key),
}));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTranslation: () => translation,
}));

const { default: ThresholdMixerPanel } = await import('./ThresholdMixerPanel');

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  api.get.mockClear();
  api.patch.mockClear();
  api.post.mockClear();
  // Sensor 2 has its own threshold (150); the object's is 100.
  api.sensors = [
    { sensor_order: 1, id: null, name: null, threshold: null, max: 50 },
    { sensor_order: 2, id: 20, name: 'Dach', threshold: 150, max: 200 },
    { sensor_order: 3, id: null, name: null, threshold: null, max: 80 },
  ];
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

const render = (canEdit = true) =>
  act(() => {
    root.render(<ThresholdMixerPanel locationId={7} initialObjectThreshold={100} canEdit={canEdit} />);
  });

// jsdom has no layout: the scroller counts as 800 px wide -> 3 sensors get
// 64 px columns; scale = 200 * 1.15 = 230 over 230 px, so y = 240 - value.
const plot = () => {
  const svg = container.querySelector<SVGSVGElement>('[data-testid="threshold-mixer-plot"]')!;
  vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 192, height: 266 } as DOMRect);
  return svg;
};
const pointer = (type: string, x: number, y: number, extra: MouseEventInit = {}) =>
  act(() => {
    plot().dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, ...extra }));
  });
const drag = (x: number, fromY: number, toY: number) => {
  pointer('pointerdown', x, fromY);
  pointer('pointermove', x, toY);
  pointer('pointerup', x, toY);
};
const changesText = () => container.querySelector('[data-testid="threshold-changes"]')!.textContent;
const button = (prefix: string) =>
  [...container.querySelectorAll('button')].find((element) => element.textContent?.startsWith(prefix))!;

describe('ThresholdMixerPanel', () => {
  it('loads the maxima of the period and marks sensors above their threshold', () => {
    render();
    expect(api.get).toHaveBeenCalledWith('/v1/location/7/measurepoints/?days=30');
    const bar = (order: number) => container.querySelector(`[data-sensor="${order}"] rect`)!.getAttribute('fill');
    expect(bar(2)).toBe('#C44D26'); // 200 > its own 150
    expect(bar(1)).toBe('#A9BCCF'); // 50 < the object's 100
    // Only sensors with an own threshold have a handle.
    expect(container.querySelectorAll('[data-handle]')).toHaveLength(1);
    expect(changesText()).toContain('einstell_mixer_no_changes');
  });

  it('drags the object line', () => {
    render();
    drag(10, 140, 116);
    expect(changesText()).toContain('einstell_mixer_object');
    expect(changesText()).toContain('100 mV → 124 mV');
  });

  it('drags a sensor handle and removes the change again', () => {
    render();
    drag(70, 90, 60);
    expect(changesText()).toContain('Dach');
    expect(changesText()).toContain('150 mV → 180 mV');
    act(() => (container.querySelector('[aria-label="einstell_mixer_undo"]') as HTMLButtonElement).click());
    expect(changesText()).toContain('einstell_mixer_no_changes');
  });

  it('moves every selected sensor together', () => {
    render();
    pointer('pointerdown', 10, 200); // select sensor 1
    pointer('pointerdown', 150, 200, { ctrlKey: true }); // add sensor 3
    expect(container.textContent).toContain('einstell_mixer_selected:{"count":2}');
    // Sensor 1 is selected: its spot on the object line grabs the selection.
    drag(10, 140, 100);
    expect(changesText()).toContain('einstell_mixer_changes:{"count":2}');
    expect(changesText()).toContain('140 mV');
  });

  it('saves only the changes', async () => {
    render();
    drag(10, 140, 116); // object 100 -> 124
    drag(70, 90, 60); // sensor 2: 150 -> 180
    await act(async () => {
      button('einstell_mixer_save').click();
    });
    expect(api.patch).toHaveBeenCalledWith('/v1/location/7/', { alarm_threshold: 124 });
    expect(api.post).toHaveBeenCalledWith('/v1/location/7/measurepoints/', {
      points: [{ sensor_order: 2, threshold: 180 }],
    });
    // Reloaded, no drafts left.
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(changesText()).toContain('einstell_mixer_no_changes');
  });

  it('removes the own thresholds of the selection', async () => {
    render();
    pointer('pointerdown', 70, 220); // select sensor 2
    act(() => button('einstell_mixer_remove_selected').click());
    expect(changesText()).toContain('150 mV → einstell_mixer_inherits');
    await act(async () => {
      button('einstell_mixer_save').click();
    });
    expect(api.patch).not.toHaveBeenCalled();
    expect(api.post).toHaveBeenCalledWith('/v1/location/7/measurepoints/', {
      points: [{ sensor_order: 2, threshold: null }],
    });
  });

  it('is read-only without the edit permission', () => {
    render(false);
    drag(10, 140, 116);
    expect(container.querySelector('[data-testid="threshold-changes"]')).toBeNull();
    expect(container.textContent).not.toContain('einstell_mixer_selected');
  });
});
