// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutoOrderResult, AutoRepairStatus } from './autoRepair';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ANSWER: AutoOrderResult = {
  lageplan_id: 3,
  cables: [
    {
      number: 2, label: 'MPLE 02', inferred: false, confidence: 0.95, head_known: true,
      line: [[0.5, 0.1], [0.7, 0.1]], marks: [[0.5, 0.9], [0.7, 0.9]],
    },
    {
      number: null, label: null, inferred: false, confidence: 0, head_known: false,
      line: [[0.1, 0.1], [0.3, 0.1]], marks: [[0.1, 0.9], [0.3, 0.9]],
    },
  ],
  marks: 4,
  marks_off_cable: 0,
  labels: 1,
  inferred: 0,
  unlabelled: 1,
  missing_numbers: [1],
  points: 3,
  ocr: true,
};

const answer = vi.hoisted(() => ({ current: null as unknown }));
const api = vi.hoisted(() => ({
  posts: [] as Array<{ url: string; data: Record<string, unknown> }>,
  gets: [] as string[],
  /** The background Auto-Repair's answers, one per ask (the last repeats). */
  statuses: [] as unknown[],
}));
vi.mock('../axiosConfig', () => ({
  default: {
    perform_post: (_auth: unknown, url: string, data: Record<string, unknown>, ok: (response: unknown) => void) => {
      api.posts.push({ url, data });
      ok({ data: url.endsWith('auto_order/') ? (answer.current ?? ANSWER) : { moved: 3, created: 1 } });
      return Promise.resolve();
    },
    perform_get: (_auth: unknown, url: string, ok: (response: unknown) => void) => {
      api.gets.push(url);
      const status = api.statuses.length > 1 ? api.statuses.shift() : api.statuses[0];
      ok({ data: status ?? { lageplan_id: 3, state: null } });
      return Promise.resolve();
    },
  },
}));
vi.mock('../../hooks/CoreAuthProvider', () => ({ useAuth: () => ({}) }));
vi.mock('notistack', () => ({ enqueueSnackbar: vi.fn() }));
// The plan image is fetched as blob - a test sets it (null: still loading).
const plan = vi.hoisted(() => ({ src: null as string | null }));
vi.mock('./DmTransferStep', () => ({ usePlanImage: () => plan.src }));

const { default: LageplanAutoRepair, STATUS_POLL_MS } = await import('./LageplanAutoRepair');

let container: HTMLDivElement;
let root: Root;
// Three points on the plan; the location's highest number is 40.
const POINTS = [1, 2, 3].map((order) => ({ id: 100 + order, sensor_order: order, nx: 0, ny: 0, name: null }));

beforeEach(() => {
  vi.useFakeTimers();
  plan.src = null;
  answer.current = null;
  api.posts.length = 0;
  api.gets.length = 0;
  api.statuses = [];
  // DataTable asks for the colour scheme; jsdom has no matchMedia.
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

const byTestId = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const numberCell = (index: number) =>
  container.querySelector(`[data-testid="auto-repair-number"][data-test-key="${index}"]`) as HTMLElement;
const badge = (number: number) =>
  container.querySelector<HTMLButtonElement>(`[data-testid="auto-repair-badge"][data-test-key="${number}"]`);
const badges = () =>
  [...container.querySelectorAll('[data-testid="auto-repair-badge"]')].map((element) => element.textContent);

const render = (props: Partial<Parameters<typeof LageplanAutoRepair>[0]> = {}) =>
  act(() =>
    root.render(
      <LageplanAutoRepair
        locationId={7078}
        planId={3}
        planUrl="/media/plan.png"
        planPoints={POINTS}
        highestOrder={40}
        canEdit
        onPreview={() => undefined}
        onStored={() => undefined}
        {...props}
      />,
    ),
  );

/** Types into a React-controlled input. */
const type = (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const wait = (ms: number) => act(() => vi.advanceTimersByTime(ms));

describe('LageplanAutoRepair', () => {
  it('reads the plan, numbers the unreadable line with a badge and applies the marks - new points for the extra ones', () => {
    const onStored = vi.fn();
    const previews: unknown[] = [];
    render({ onStored, onPreview: (points) => previews.push(points) });

    act(() => byTestId('auto-repair-start')!.click());

    expect(api.posts[0]).toEqual({ url: '/v1/status/measure_points/auto_order/', data: { location_id: 7078, lageplan_id: 3 } });
    expect(byTestId('auto-repair-summary')!.textContent).toContain('1 unreadable');
    expect(byTestId('auto-repair-problem')!.textContent).toContain('1 MPLE line(s) without a number');
    expect((byTestId('auto-repair-apply') as HTMLButtonElement).disabled).toBe(true);
    // The line without a number is picked at once; the missing MPLE 01 is a badge.
    expect(byTestId('auto-repair-selected')!.textContent).toContain('no number yet');
    expect(badges()).toEqual(['MPLE 01']);

    act(() => badge(1)!.click());

    expect(badges()).toEqual([]);
    expect(numberCell(1).textContent).toBe('MPLE 01');
    expect((byTestId('auto-repair-apply') as HTMLButtonElement).disabled).toBe(false);
    expect(byTestId('auto-repair-apply')!.textContent).toContain('4 points, 1 new');
    const preview = previews[previews.length - 1] as Array<{ id: number; sensor_order: number; nx: number }>;
    expect(preview.map((point) => [point.id, point.sensor_order, point.nx])).toEqual([
      [101, 1, 0.1], [102, 2, 0.3], [103, 3, 0.5], [-1, 41, 0.7],
    ]);

    act(() => byTestId('auto-repair-apply')!.click());

    expect(api.posts[1]).toEqual({
      url: '/v1/status/measure_points/auto_order/apply/',
      data: { location_id: 7078, lageplan_id: 3, marks: [[0.1, 0.9], [0.3, 0.9], [0.5, 0.9], [0.7, 0.9]] },
    });
    expect(onStored).toHaveBeenCalled();
    // Back to the start; the canvas shows the stored points again.
    expect(byTestId('auto-repair-start')).not.toBeNull();
    expect(previews[previews.length - 1]).toBeNull();
  });

  it('moves on to the next line without a number after each badge', () => {
    answer.current = {
      ...ANSWER,
      cables: [...ANSWER.cables, { ...ANSWER.cables[1], line: [[0.1, 0.5], [0.3, 0.5]], marks: [[0.1, 0.5]] }],
      missing_numbers: [1, 3],
      unlabelled: 2,
    };
    render();
    act(() => byTestId('auto-repair-start')!.click());
    expect(badges()).toEqual(['MPLE 01', 'MPLE 03']);

    act(() => badge(3)!.click());
    // The first open line got MPLE 03, the next one is picked.
    expect(numberCell(1).textContent).toBe('MPLE 03');
    expect(byTestId('auto-repair-selected')!.textContent).toContain('no number yet');
    act(() => badge(1)!.click());

    expect(numberCell(2).textContent).toBe('MPLE 01');
    expect(byTestId('auto-repair-problem')!.textContent).not.toContain('without a number');
  });

  it('gives a line another number - its old one becomes a badge again', () => {
    render();
    act(() => byTestId('auto-repair-start')!.click());
    act(() => badge(1)!.click());

    // The line read as MPLE 02, picked in the table.
    act(() => numberCell(0).click());
    expect(byTestId('auto-repair-selected')!.textContent).toContain('now MPLE 02');
    act(() => byTestId('auto-repair-clear')!.click());

    expect(numberCell(0).textContent).toBe('no number');
    expect(badges()).toEqual(['MPLE 02']);
  });

  it('adds a badge for a free number only', () => {
    render();
    act(() => byTestId('auto-repair-start')!.click());

    type(byTestId('auto-repair-badge-input') as HTMLInputElement, '2');
    act(() => byTestId('auto-repair-badge-add')!.click());
    expect(byTestId('auto-repair-badge-problem')!.textContent).toBe('MPLE 2 belongs to a line already');

    type(byTestId('auto-repair-badge-input') as HTMLInputElement, '7');
    act(() => byTestId('auto-repair-badge-add')!.click());
    expect(byTestId('auto-repair-badge-problem')).toBeNull();
    expect(badges()).toEqual(['MPLE 01', 'MPLE 07']);

    act(() => badge(7)!.click());
    expect(numberCell(1).textContent).toBe('MPLE 07');
  });

  it('turns a line: its marks are numbered from the other end', () => {
    const previews: unknown[] = [];
    render({ onPreview: (points) => previews.push(points) });
    act(() => byTestId('auto-repair-start')!.click());
    act(() => badge(1)!.click());

    act(() => byTestId('auto-repair-turn-1')!.click());

    const preview = previews[previews.length - 1] as Array<{ id: number; nx: number }>;
    expect(preview.slice(0, 2).map((point) => point.nx)).toEqual([0.3, 0.1]);
  });

  it('follows the background Auto-Repair of an upload until it placed the points', () => {
    const onStored = vi.fn();
    api.statuses = [
      { lageplan_id: 3, state: 'running' } satisfies AutoRepairStatus,
      { lageplan_id: 3, state: 'applied', placed: { moved: 3, created: 1, kept: 0 } } satisfies AutoRepairStatus,
    ];
    render({ onStored });

    expect(api.gets[0]).toBe('/v1/status/measure_points/auto_order/status/?location_id=7078&lageplan_id=3');
    expect(byTestId('auto-repair-running')).not.toBeNull();
    expect(byTestId('auto-repair-start')).toBeNull();

    wait(STATUS_POLL_MS);

    expect(onStored).toHaveBeenCalledTimes(1);
    expect(byTestId('auto-repair-running')).toBeNull();
    expect(byTestId('auto-repair-start')).not.toBeNull();
  });

  it('opens the review the background Auto-Repair left', () => {
    api.statuses = [{ lageplan_id: 3, state: 'review', message: '1 MPLE line(s) without a readable number', result: ANSWER }];
    render();

    expect(byTestId('auto-repair-review')!.textContent).toContain('1 MPLE line(s) without a readable number');
    expect(byTestId('auto-repair-summary')).not.toBeNull();
  });

  it('zooms and moves the plan overview like the other plans', () => {
    plan.src = 'blob:plan';
    // jsdom loads no images: this one is 2000 x 1000.
    vi.stubGlobal('Image', class {
      naturalWidth = 2000;
      naturalHeight = 1000;
      onload: (() => void) | null = null;
      set src(_value: string) {
        setTimeout(() => this.onload?.(), 0);
      }
    });
    render();
    act(() => byTestId('auto-repair-start')!.click());
    wait(0);
    const svg = () => byTestId('auto-repair-overview-plan')!;
    expect(svg().getAttribute('viewBox')).toBe('0 0 2000 1000');

    act(() => byTestId('auto-repair-overview-zoom-in')!.click());
    const [x, y, w, h] = svg().getAttribute('viewBox')!.split(' ').map(Number);
    expect([w, h]).toEqual([2000 / 1.5, 1000 / 1.5]);
    expect([x, y]).toEqual([(2000 - w) / 2, (1000 - h) / 2]);

    // Ctrl + wheel zooms further, the plain wheel only shows how.
    act(() => {
      svg().dispatchEvent(new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true }));
    });
    expect(Number(svg().getAttribute('viewBox')!.split(' ')[2])).toBeLessThan(w);
    act(() => {
      svg().dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }));
    });
    expect(byTestId('auto-repair-overview-wheel-hint')).not.toBeNull();

    act(() => byTestId('auto-repair-overview-zoom-reset')!.click());
    expect(svg().getAttribute('viewBox')).toBe('0 0 2000 1000');
    vi.unstubAllGlobals();
  });

  it('is not offered without the permission to edit', () => {
    render({ canEdit: false });
    expect((byTestId('auto-repair-start') as HTMLButtonElement).disabled).toBe(true);
  });
});
