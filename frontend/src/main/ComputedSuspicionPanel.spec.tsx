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
  ...overrides,
});

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

  it('says so when there is nothing or no access', () => {
    renderPanel({ points: [] });
    expect(byTestId('computed-suspicion-empty')).not.toBeNull();

    renderPanel({ denied: true });
    expect(byTestId('computed-suspicion-denied')).not.toBeNull();
  });
});
