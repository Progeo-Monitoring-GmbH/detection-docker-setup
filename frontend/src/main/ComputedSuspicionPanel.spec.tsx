// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComputedSuspicionPoint } from './computedSuspicion';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const translation = vi.hoisted(() => ({
  t: (key: string, values?: Record<string, unknown>) =>
    values?.count != null ? `${key}:${values.count}` : key,
  i18n: { language: 'de' },
}));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTranslation: () => translation,
}));

const { default: ComputedSuspicionPanel } =
  await import('./ComputedSuspicionPanel');

const point = (
  id: string,
  overrides: Partial<ComputedSuspicionPoint> = {},
): ComputedSuspicionPoint => ({
  id,
  x: 0.2,
  y: 0.3,
  lageplan: 5,
  strength: 1,
  sensor_ids: [3, 4, 5],
  state: 'neu',
  active: true,
  severity: 'alarm',
  max_value: 250,
  max_exceedance: 2.5,
  first_seen: null,
  last_seen: null,
  readings: 3,
  alarm_ids: [10, 20],
  pending_ack_alarm_ids: [10],
  x_m: null,
  y_m: null,
  alarms: [],
  ...overrides,
});

/** `count` readings of the sensors 3 and 4, newest first. */
const history = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: `${index % 2 ? 4 : 3}:${index}`,
    sensor_id: index % 2 ? 4 : 3,
    triggered_at: new Date(Date.UTC(2026, 10, 20, 12) - index * 60_000).toISOString(),
    value: 200 + index,
    state: 'neu' as const,
  }));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // DataTable asks for the colour scheme; jsdom has no matchMedia.
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
  // Its pagination watches its size.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const renderPanel = (
  props: Partial<Parameters<typeof ComputedSuspicionPanel>[0]> = {},
) => {
  const onAcknowledge = vi.fn();
  act(() => {
    root.render(
      <ComputedSuspicionPanel
        points={[
          point('computed-3'),
          point('computed-9', { state: 'geloest', pending_ack_alarm_ids: [] }),
        ]}
        loading={false}
        denied={false}
        sensorLabel={(id) => `Sensor ${id}`}
        acknowledging={new Set()}
        onAcknowledge={onAcknowledge}
        readOnly={false}
        {...props}
      />,
    );
  });
  return onAcknowledge;
};

const byTestId = (id: string, key?: string) =>
  container.querySelector<HTMLElement>(
    `[data-testid="${id}"]${key ? `[data-test-key="${key}"]` : ''}`,
  );

describe('ComputedSuspicionPanel', () => {
  it('letters the points like their rings on the plan and lists their sensors', () => {
    renderPanel();

    const rows = container.querySelectorAll(
      '[data-testid="computed-suspicion-row"]',
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('A');
    expect(rows[0].textContent).toContain('suspicion_computed_point:3');
    expect(rows[0].textContent).toContain('Sensor 3, Sensor 4, Sensor 5');
    expect(
      rows[1].querySelector('.computed-suspicion-letter--geloest')?.textContent,
    ).toBe('B');
  });

  it('acknowledges a point from its details - after the confirmation, which counts its alarms', () => {
    const onAcknowledge = renderPanel();

    act(() => byTestId('computed-suspicion-toggle', 'computed-3')?.click());
    act(() =>
      byTestId('computed-suspicion-acknowledge', 'computed-3')?.click(),
    );
    const dialog = byTestId('computed-suspicion-acknowledge-dialog');
    expect(dialog?.textContent).toContain('acknowledge_alarms_point_message:1');
    expect(onAcknowledge).not.toHaveBeenCalled();

    act(() => byTestId('computed-suspicion-acknowledge-dialog-confirm')?.click());
    expect(onAcknowledge).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'computed-3' }),
    );
    expect(byTestId('computed-suspicion-acknowledge-dialog')).toBeNull();
  });

  it('acknowledges nothing when the confirmation is cancelled', () => {
    const onAcknowledge = renderPanel();

    act(() => byTestId('computed-suspicion-toggle', 'computed-3')?.click());
    act(() =>
      byTestId('computed-suspicion-acknowledge', 'computed-3')?.click(),
    );
    act(() => byTestId('computed-suspicion-acknowledge-dialog-cancel')?.click());

    expect(onAcknowledge).not.toHaveBeenCalled();
    expect(byTestId('computed-suspicion-acknowledge-dialog')).toBeNull();
  });

  it('offers nothing to acknowledge without pending alarms, and nothing in the demo', () => {
    renderPanel({ readOnly: true });

    act(() => byTestId('computed-suspicion-toggle', 'computed-9')?.click());
    const button = byTestId(
      'computed-suspicion-acknowledge',
      'computed-9',
    ) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.hidden).toBe(true);
  });

  it('pages the alarm history of a point, 25 rows at a time, with the sensor of each', () => {
    renderPanel({ points: [point('computed-3', { alarms: history(30) })] });

    act(() => byTestId('computed-suspicion-toggle', 'computed-3')?.click());

    const rows = container.querySelectorAll(
      '[data-testid="computed-suspicion-history-row"]',
    );
    expect(rows).toHaveLength(25);
    const table = byTestId('computed-suspicion-history-computed-3');
    expect(table?.textContent).toContain('status_col_sensor');
    expect(table?.textContent).toContain('Sensor 4');
  });

  it('names a single-sensor point by its sensor and marks it unplaced without a position', () => {
    renderPanel({
      points: [
        point('computed-9', { sensor_ids: [9], x: null, y: null, lageplan: null }),
      ],
    });

    const row = byTestId('computed-suspicion-row', 'computed-9');
    expect(row?.textContent).toContain('Sensor 9');
    expect(row?.textContent).toContain('suspicion_unplaced');
  });

  it('shows the header actions (the staff switch) in the panel header', () => {
    renderPanel({ headerActions: <span data-testid="switch">switch</span> });

    expect(
      container.querySelector('.progeo-panel-head [data-testid="switch"]'),
    ).not.toBeNull();
  });

  it('says so when there is nothing or no access', () => {
    renderPanel({ points: [] });
    expect(byTestId('computed-suspicion-empty')).not.toBeNull();

    renderPanel({ denied: true });
    expect(byTestId('computed-suspicion-denied')).not.toBeNull();
  });
});
