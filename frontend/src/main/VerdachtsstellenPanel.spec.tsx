// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VerdachtsstelleCluster } from './locationStatusData';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const translation = vi.hoisted(() => ({
  t: (key: string, options?: { count?: number }) => (options?.count != null ? `${key}:${options.count}` : key),
  i18n: { language: 'de' },
}));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTranslation: () => translation,
}));

const { default: VerdachtsstellenPanel } = await import('./VerdachtsstellenPanel');

const cluster = (id: string, sensor: number, state: VerdachtsstelleCluster['state']): VerdachtsstelleCluster => ({
  id,
  sensor_id: sensor,
  device_ids: [],
  device_label: null,
  device_type: null,
  alarm_ids: [],
  state,
  active: state !== 'geloest',
  severity: 'alarm',
  max_value: 120,
  since: null,
  resolved_at: null,
  ack_by: null,
  ack_at: null,
  pending_ack_alarm_ids: [],
  alarms: [],
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // The Alarm-Verlauf is a DataTable, which asks for the colour scheme; jsdom has no matchMedia.
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

const render = (
  clusters: VerdachtsstelleCluster[],
  onAcknowledge: (cluster: VerdachtsstelleCluster) => void = () => undefined,
  onShowMoment?: (at: string) => void,
) =>
  act(() =>
    root.render(
      <VerdachtsstellenPanel
        clusters={clusters}
        denied={false}
        sensorLabel={(sensor) => `Sensor ${sensor}`}
        metersOf={() => null}
        acknowledging={new Set()}
        onAcknowledge={onAcknowledge}
        readOnly={false}
        onShowMoment={onShowMoment}
      />,
    ),
  );

const byTestId = (id: string) => container.querySelector(`[data-testid="${id}"]`);
const rowIds = (listId: string) =>
  Array.from(byTestId(listId)?.querySelectorAll('[data-testid="verdachtsstelle"]') ?? []).map((row) =>
    row.getAttribute('data-test-key'),
  );

describe('VerdachtsstellenPanel', () => {
  it('lists only the open clusters by default, the resolved ones collapsed behind "Resolved (n)"', () => {
    render([cluster('a', 1, 'neu'), cluster('b', 2, 'geloest'), cluster('c', 3, 'quittiert')]);
    expect(rowIds('verdachtsstellen-list')).toEqual(['a', 'c']);
    expect(byTestId('verdachtsstellen-resolved-toggle')?.textContent).toBe('status_verdachtsstellen_resolved:1');
    expect(byTestId('verdachtsstellen-resolved-list')).toBeNull();

    act(() => (byTestId('verdachtsstellen-resolved-toggle') as HTMLButtonElement).click());
    expect(rowIds('verdachtsstellen-resolved-list')).toEqual(['b']);
    expect(byTestId('verdachtsstellen-resolved-toggle')?.getAttribute('aria-expanded')).toBe('true');
  });

  it('shows the empty note when every cluster is resolved', () => {
    render([cluster('b', 2, 'geloest')]);
    expect(byTestId('verdachtsstellen-empty')).not.toBeNull();
    expect(byTestId('verdachtsstellen-resolved')).not.toBeNull();
  });

  it('has no resolved section and no "view all" link without resolved clusters', () => {
    render([cluster('a', 1, 'neu')]);
    expect(byTestId('verdachtsstellen-resolved')).toBeNull();
    expect(byTestId('verdachtsstellen-view-all')).toBeNull();
  });

  it('acknowledges the pending alarms of a cluster only after the confirmation, which counts them', () => {
    const onAcknowledge = vi.fn();
    render([{ ...cluster('a', 1, 'neu'), pending_ack_alarm_ids: [5, 6] }], onAcknowledge);
    const click = (id: string) =>
      act(() => (container.querySelector(`[data-testid="${id}"][data-test-key="a"], [data-testid="${id}"]:not([data-test-key])`) as HTMLButtonElement).click());

    click('verdachtsstelle-toggle');
    click('verdachtsstelle-acknowledge');
    expect(byTestId('verdachtsstelle-acknowledge-dialog')?.textContent).toContain(
      'acknowledge_alarms_verdachtsstelle_message:2',
    );
    click('verdachtsstelle-acknowledge-dialog-cancel');
    expect(byTestId('verdachtsstelle-acknowledge-dialog')).toBeNull();
    expect(onAcknowledge).not.toHaveBeenCalled();

    click('verdachtsstelle-acknowledge');
    click('verdachtsstelle-acknowledge-dialog-confirm');
    expect(onAcknowledge).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
  });
});

describe('VerdachtsstellenPanel - Alarm-Verlauf', () => {
  it('pages the alarm history in a DataTable, 10 rows at a time', () => {
    const open = cluster('sensor-6', 6, 'neu');
    open.alarms = Array.from({ length: 40 }, (_, index) => ({
      id: index,
      triggered_at: new Date(Date.UTC(2026, 10, 20, 12) - index * 60_000).toISOString(),
      value: 150 + index,
      state: 'neu' as const,
    }));
    render([open]);

    act(() => (container.querySelector('[data-testid="verdachtsstelle-toggle"]') as HTMLElement).click());

    expect(container.querySelectorAll('[data-testid="verdachtsstelle-history-row"]')).toHaveLength(10);
    expect(byTestId('verdachtsstelle-history-sensor-6')).not.toBeNull();
  });
});

describe('VerdachtsstellenPanel - first detection', () => {
  it('sets the time slider to the oldest alarm of the Verdachtsstelle', () => {
    const onShowMoment = vi.fn();
    render(
      [
        {
          ...cluster('c1', 7, 'neu'),
          since: '2026-11-20T10:00:00Z',
          alarms: [
            { id: 2, triggered_at: '2026-11-20T10:00:00Z', value: 150, state: 'neu' },
            { id: 1, triggered_at: '2026-11-02T08:00:00Z', value: 130, state: 'geloest' },
          ],
        },
      ],
      undefined,
      onShowMoment,
    );
    act(() => (container.querySelector('[data-testid="verdachtsstelle-toggle"]') as HTMLButtonElement).click());
    act(() => (byTestId('verdachtsstelle-first-seen') as HTMLButtonElement).click());
    expect(onShowMoment).toHaveBeenCalledWith('2026-11-02T08:00:00Z');
  });
});
