// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SensorListRow } from './SensorListTable';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const translation = vi.hoisted(() => ({
  t: (key: string, options?: Record<string, unknown>) => (options ? `${key}:${JSON.stringify(options)}` : key),
}));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTranslation: () => translation,
}));

const { default: SensorStatusTiles, sensorTileState } = await import('./SensorStatusTiles');

const row = (key: string, value: number | null, threshold: number | null = 100, extra: Partial<SensorListRow> = {}) =>
  ({ key, label: `Sensor ${key}`, value, max: value, threshold, ...extra }) as SensorListRow;

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

const render = (rows: SensorListRow[]) =>
  act(() => {
    root.render(<SensorStatusTiles rows={rows} />);
  });
const tile = (key: string) =>
  container.querySelector(`[data-testid="sensor-tiles-tile"][data-test-key="${key}"]`) as HTMLElement;

describe('sensorTileState', () => {
  it('is ok up to the threshold and alarm above it', () => {
    expect(sensorTileState(row('1', 100))).toBe('ok');
    expect(sensorTileState(row('1', 101))).toBe('alarm');
    expect(sensorTileState(row('1', 5000, null))).toBe('ok'); // nothing to exceed
  });

  it('is disabled before anything else, and nodata without a reading', () => {
    expect(sensorTileState(row('1', 900, 100, { disabled: true }))).toBe('disabled');
    expect(sensorTileState(row('1', null))).toBe('nodata');
  });
});

describe('SensorStatusTiles', () => {
  it('shows every sensor with its name, its state and its value against the threshold, in order', () => {
    render([row('1', 40), row('2', 180), row('3', null), row('4', 900, 100, { disabled: true })]);

    const tiles = [...container.querySelectorAll('[data-testid="sensor-tiles-tile"]')];
    expect(tiles.map((element) => element.getAttribute('data-state'))).toEqual(['ok', 'alarm', 'nodata', 'disabled']);
    expect(tile('1').textContent).toContain('Sensor 1');
    expect(tile('1').querySelector('.sensor-tile-status')!.textContent).toBe('sensor_tile_ok');
    expect(tile('2').querySelector('.sensor-tile-status')!.textContent).toBe('sensor_tile_alarm');
    expect(tile('2').textContent).toContain('sensor_tile_reading:{"value":"180","threshold":"100"}');
    expect(tile('4').textContent).toContain('status_sensor_table_disabled_hint');
    expect(tile('2').className).toContain('sensor-tile--alarm');
  });

  it('says so when there are no sensors', () => {
    render([]);
    expect(container.querySelector('[data-testid="sensor-tiles-empty"]')).not.toBeNull();
  });
});
