// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ answers: {} as Record<string, unknown>, post: vi.fn() }));

vi.mock('../../axiosConfig', () => ({
  default: {
    perform_get: (_auth: unknown, url: string, ok: (response: unknown) => void) =>
      ok({ data: api.answers[url] ?? {} }),
    perform_post: (_auth: unknown, url: string, body: unknown, ok: (response: unknown) => void) => {
      api.post(url, body);
      ok({ data: { applied: [], skipped: [] } });
    },
  },
}));
vi.mock('../../../hooks/CoreAuthProvider', () => ({ useAuth: () => ({}) }));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

const module = await import('./ThresholdFineTuneView');
const { default: ThresholdFineTuneView, safetyMargin, sliderRange, marginLevel, initialThreshold } = module;
type Entry = Parameters<typeof initialThreshold>[0];

const FILE = 'fine_tune_20261121_080000.json';
const ENTRY = (overrides: Partial<Entry> = {}): Entry => ({
  key: 'default:7',
  location_id: 7,
  project_id: 4700,
  name: 'Halle Fein',
  current_threshold: 100,
  live_threshold: 100,
  max_value: 60,
  max_at: { value: 60, sensor_order: 2, device_id: 1, at: '2026-11-20T10:00:00' },
  action: 'lower',
  proposed: 75,
  change_percent: -25,
  measurements: 400,
  excluded_sensors: [],
  active_alarms: 0,
  warnings: [],
  ...overrides,
});

describe('helpers', () => {
  it('measures the safety margin above the true maximum', () => {
    expect(safetyMargin(75, 60)).toBe(25);
    expect(safetyMargin(50, 60)).toBeCloseTo(-16.67, 1);
    expect(safetyMargin(75, null)).toBeNull();
  });

  it('colours the margin by the buffer', () => {
    expect(marginLevel(-1, 25)).toBe('danger');
    expect(marginLevel(10, 25)).toBe('warn');
    expect(marginLevel(25, 25)).toBe('ok');
    expect(marginLevel(null, 25)).toBe('none');
  });

  it('starts at the proposal and spans maximum, threshold and proposal', () => {
    expect(initialThreshold(ENTRY())).toBe(75);
    expect(initialThreshold(ENTRY({ proposed: null, action: 'no_data', max_value: null }))).toBe(100);
    expect(sliderRange(ENTRY())).toEqual({ min: 30, max: 160 });
  });
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  api.post.mockClear();
  api.answers = {
    '/v1/threshold-fine-tune/': { files: [{ file: FILE, created_at: '2026-11-21T08:00:00', locations: 1, applied: 0 }] },
    [`/v1/threshold-fine-tune/${FILE}/`]: {
      findings: {
        file: FILE,
        created_at: '2026-11-21T08:00:00',
        params: { days: 30, buffer_percent: 25, minimum: 30, max_raise_percent: 15, step_minutes: null, projects: null },
        summary: { lower: 1 },
        locations: [ENTRY()],
        stale: null,
      },
    },
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = async () => {
  await act(async () => {
    root.render(<ThresholdFineTuneView />);
  });
};

const setNumber = (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const q = <T extends Element>(selector: string) => container.querySelector<T>(selector);

describe('ThresholdFineTuneView', () => {
  it('shows the proposal with its safety margin', async () => {
    await render();
    expect(q<HTMLInputElement>('[data-testid="ftt-number"]')!.value).toBe('75');
    expect(q('[data-testid="ftt-margin"]')!.textContent).toContain('+25 %');
  });

  it('a changed threshold moves the margin, selects the row and is applied', async () => {
    await render();
    const apply = q<HTMLButtonElement>('[data-testid="ftt-apply"]')!;
    expect(apply.disabled).toBe(true); // nothing selected yet

    setNumber(q<HTMLInputElement>('[data-testid="ftt-number"]')!, '57');

    const margin = q('[data-testid="ftt-margin"]')!;
    expect(margin.textContent).toContain('-5.0 %');
    expect(margin.className).toContain('ftt-margin--danger');
    expect(apply.disabled).toBe(false);

    act(() => apply.click());
    const confirm = document.querySelector<HTMLButtonElement>('[data-testid="ftt-apply-confirm"]')!;
    expect(document.querySelector('[data-testid="ftt-apply-row"]')!.textContent).toContain('100 → 57');
    await act(async () => confirm.click());

    expect(api.post).toHaveBeenCalledWith(`/v1/threshold-fine-tune/${FILE}/apply/`, {
      thresholds: { 'default:7': 57 },
    });
  });

  it('removes the selected rows from the file', async () => {
    await render();
    act(() => q<HTMLInputElement>('input[type="checkbox"][aria-label="Select row"]')!.click());
    act(() => q<HTMLButtonElement>('[data-testid="ftt-remove"]')!.click());
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="ftt-remove-confirm"]')!.click());

    expect(api.post).toHaveBeenCalledWith(`/v1/threshold-fine-tune/${FILE}/remove/`, { keys: ['default:7'] });
  });

  it('refuses to apply stale findings', async () => {
    const findings = api.answers[`/v1/threshold-fine-tune/${FILE}/`] as { findings: Record<string, unknown> };
    findings.findings.stale = 'older than 7 day(s)';
    await render();
    setNumber(q<HTMLInputElement>('[data-testid="ftt-number"]')!, '80');
    expect(q('[data-testid="ftt-stale"]')).not.toBeNull();
    expect(q<HTMLButtonElement>('[data-testid="ftt-apply"]')!.disabled).toBe(true);
  });
});
