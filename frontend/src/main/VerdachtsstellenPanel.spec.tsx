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
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = (clusters: VerdachtsstelleCluster[]) =>
  act(() =>
    root.render(
      <VerdachtsstellenPanel
        clusters={clusters}
        denied={false}
        sensorLabel={(sensor) => `Sensor ${sensor}`}
        metersOf={() => null}
        acknowledging={new Set()}
        onAcknowledge={() => undefined}
        readOnly={false}
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
});
