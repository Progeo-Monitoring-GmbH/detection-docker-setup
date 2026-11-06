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
  // The object's threshold is 100. Sensor 2 has its own 150 (and is above
  // it), sensor 4 its own 150 below its maximum 120 - protected; sensor 5
  // stays below 5 % of 100 - quiet.
  api.sensors = [
    { sensor_order: 1, id: null, name: null, threshold: null, max: 50 },
    { sensor_order: 2, id: 20, name: 'Dach', threshold: 150, max: 200 },
    { sensor_order: 3, id: null, name: null, threshold: null, max: 80 },
    { sensor_order: 4, id: 40, name: null, threshold: 150, max: 120 },
    { sensor_order: 5, id: null, name: null, threshold: null, max: 3 },
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

// jsdom has no layout: everything sits at 0/0 and the scroller counts as
// 800 px wide -> 5 sensors get 64 px columns (sensor n: x 64(n-1)..64n);
// scale = 200 * 1.15 = 230 over 230 px, so y = 240 - value.
const noLayout = () =>
  vi
    .spyOn(Element.prototype, 'getBoundingClientRect')
    .mockReturnValue({ left: 0, top: 0, width: 320, height: 266 } as DOMRect);
const plot = () => container.querySelector<SVGSVGElement>('[data-testid="threshold-mixer-plot"]')!;
const fire = (target: Element, type: string, x: number, y: number, extra: MouseEventInit = {}) =>
  act(() => {
    noLayout();
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, ...extra }));
  });
const pointer = (type: string, x: number, y: number, extra: MouseEventInit = {}) => fire(plot(), type, x, y, extra);
const drag = (x: number, fromY: number, toY: number) => {
  pointer('pointerdown', x, fromY);
  pointer('pointermove', x, toY);
  pointer('pointerup', x, toY);
};
/** The object line: by its grip on the y-axis. */
const dragObject = (fromY: number, toY: number) => {
  const grip = container.querySelector('[role="slider"]')!;
  fire(grip, 'pointerdown', 20, fromY);
  fire(grip, 'pointermove', 20, toY);
  fire(grip, 'pointerup', 20, toY);
};
const changesText = () => container.querySelector('[data-testid="threshold-changes"]')!.textContent;
const button = (prefix: string) =>
  [...container.querySelectorAll('button')].find((element) => element.textContent?.startsWith(prefix))!;
const bar = (order: number) => container.querySelector(`[data-sensor="${order}"] [data-bar]`)!;

describe('ThresholdMixerPanel', () => {
  it('loads the maxima of 3 days and marks over, protected and plain bars', () => {
    render();
    expect(api.get).toHaveBeenCalledWith('/v1/location/7/measurepoints/?days=3');
    expect(bar(2).getAttribute('fill')).toBe('#C44D26'); // 200 > its own 150
    expect(bar(1).getAttribute('fill')).toBe('#A9BCCF'); // 50 < the object's 100
    // 120 > the object's 100, but its own 150 protects it: striped.
    expect(bar(4).getAttribute('fill')).toMatch(/^url\(#mixer-protected-/);
    // Only sensors with an own threshold have a marker.
    expect(container.querySelectorAll('[data-handle]')).toHaveLength(2);
    expect(changesText()).toContain('einstell_mixer_no_changes');
  });

  it('draws a light grid at round values', () => {
    render();
    const labels = [...container.querySelectorAll('svg')[0].querySelectorAll('text')].map((text) => text.textContent);
    expect(labels).toEqual(expect.arrayContaining(['0', '50', '100', '150', '200']));
  });

  it('drags the object line by its grip', () => {
    render();
    dragObject(140, 116);
    expect(changesText()).toContain('einstell_mixer_object');
    expect(changesText()).toContain('100 mV → 124 mV');
  });

  it('places a marker where the plot is clicked - not the object line', () => {
    render();
    // Sensor 3 inherits; the click is right on the object line (y 140 = 100).
    pointer('pointerdown', 150, 120);
    pointer('pointermove', 150, 100);
    pointer('pointerup', 150, 100);
    expect(changesText()).toContain('einstell_mixer_changes:{"count":1}');
    expect(changesText()).toContain('einstell_mixer_inherits');
    expect(changesText()).toContain('→ 140 mV');
    expect(changesText()).not.toContain('einstell_mixer_object');
  });

  it('grabs a marker before placing a new one - with a larger grab area', () => {
    render();
    // Sensor 2's marker sits at y 90 (150); 10 px off still grabs it.
    drag(70, 100, 60);
    expect(changesText()).toContain('Dach');
    expect(changesText()).toContain('150 mV → 180 mV');
    act(() => (container.querySelector('[aria-label="einstell_mixer_undo"]') as HTMLButtonElement).click());
    expect(changesText()).toContain('einstell_mixer_no_changes');
  });

  it('moves every selected sensor together', () => {
    render();
    pointer('pointerdown', 10, 200, { ctrlKey: true }); // select sensor 1
    pointer('pointerdown', 150, 200, { ctrlKey: true }); // add sensor 3
    expect(container.textContent).toContain('einstell_mixer_selected:{"count":2}');
    expect(changesText()).toContain('einstell_mixer_no_changes');
    // Sensor 1 is selected: its spot on the object line grabs the selection.
    drag(10, 140, 100);
    expect(changesText()).toContain('einstell_mixer_changes:{"count":2}');
    expect(changesText()).toContain('140 mV');
  });

  it('outlines the hovered bar', () => {
    render();
    pointer('pointermove', 10, 200);
    expect(bar(1).getAttribute('stroke')).toBe('#0b3659');
    expect(bar(3).getAttribute('stroke')).toBe('none');
  });

  it('hides the quiet sensors on request', () => {
    render();
    expect(container.querySelector('[data-sensor="5"]')).not.toBeNull();
    act(() => button('einstell_mixer_hide_quiet').click());
    expect(container.querySelector('[data-sensor="5"]')).toBeNull();
    expect(container.textContent).toContain('einstell_mixer_quiet_hidden:{"count":1}');
  });

  it('scrolls with the arrow keys', () => {
    render();
    const scroller = plot().parentElement!;
    const scrollBy = vi.fn();
    Object.defineProperty(scroller, 'scrollBy', { value: scrollBy, configurable: true });
    act(() => {
      scroller.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    // Five 64 px columns.
    expect(scrollBy).toHaveBeenCalledWith({ left: 320, behavior: 'smooth' });
  });

  it('saves only the changes', async () => {
    render();
    dragObject(140, 116); // object 100 -> 124
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
    pointer('pointerdown', 70, 220, { ctrlKey: true }); // select sensor 2
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

  it('removes a marker that is clicked - a slight jitter still counts as a click', () => {
    render();
    // Sensor 2's marker at y 90 (150): pressed and released 2 px lower.
    pointer('pointerdown', 70, 90);
    pointer('pointermove', 70, 92);
    pointer('pointerup', 70, 92);
    expect(changesText()).toContain('Dach');
    expect(changesText()).toContain('150 mV → einstell_mixer_inherits');
    expect(container.querySelector('[data-handle="2"]')).toBeNull();
  });

  it('grabs the object line over a sensor without a marker', () => {
    render();
    // Sensor 3 inherits; y 140 is the line (100).
    drag(150, 140, 116);
    expect(changesText()).toContain('einstell_mixer_changes:{"count":1}');
    expect(changesText()).toContain('einstell_mixer_object');
    expect(changesText()).toContain('100 mV → 124 mV');
  });

  it('leaves the line alone where a marker is - the marker wins', () => {
    // Sensor 1's own 105 sits right above the line (100): y 135 vs 140.
    api.sensors = [
      { sensor_order: 1, id: 10, name: 'Keller', threshold: 105, max: 50 },
      { sensor_order: 2, id: null, name: null, threshold: null, max: 200 },
    ];
    render();
    drag(10, 138, 100);
    expect(changesText()).toContain('Keller');
    expect(changesText()).not.toContain('einstell_mixer_object');
  });

  it('works on the page\'s loaded data - no request, no period to pick', async () => {
    const sensors: MixerSensor[] = [
      { sensor_order: 1, id: null, name: null, threshold: null, max: 50 },
      { sensor_order: 2, id: null, name: 'Dach', threshold: 150, max: 200 },
    ];
    act(() => {
      root.render(
        <ThresholdMixerPanel
          locationId={7}
          initialObjectThreshold={100}
          canEdit
          loaded={{ sensors, note: 'aus den geladenen Messungen' }}
        />,
      );
    });
    expect(api.get).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="threshold-mixer-source"]')!.textContent).toBe(
      'aus den geladenen Messungen',
    );
    expect(container.textContent).not.toContain('einstell_mixer_24h');
    expect(bar(2).getAttribute('fill')).toBe('#C44D26');

    // Sensor 2's marker (150 -> y 90 on the 230 scale) is moved up and saved:
    // still no request - the page reloads its data, the panel keeps the value.
    drag(70, 90, 60);
    await act(async () => {
      button('einstell_mixer_save').click();
    });
    expect(api.post).toHaveBeenCalledWith('/v1/location/7/measurepoints/', {
      points: [{ sensor_order: 2, threshold: 180 }],
    });
    expect(api.get).not.toHaveBeenCalled();
    expect(changesText()).toContain('einstell_mixer_no_changes');
    // The saved 180 stays until the page's data has it (y = 240 - 180, the handle 3 px above).
    expect(Number(container.querySelector('[data-handle="2"]')!.getAttribute('y'))).toBeCloseTo(240 - 180 - 3);
  });

  it('is read-only without the edit permission', () => {
    render(false);
    drag(150, 120, 100);
    dragObject(140, 116);
    expect(container.querySelector('[data-testid="threshold-changes"]')).toBeNull();
    expect(container.textContent).not.toContain('einstell_mixer_selected');
  });
});
