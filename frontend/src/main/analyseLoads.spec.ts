import { describe, expect, it } from 'vitest';
import type { SensorHeatmapResponse } from '../components/device/sensorHeatmapTypes';
import {
  deviceQuery,
  heatmapComplete,
  type LoadCache,
  measurementRowsOf,
  measurementsLoadOf,
  recallLoad,
  rememberLoad,
} from './analyseLoads';

describe('deviceQuery', () => {
  it('names the device, nothing for the default', () => {
    expect(deviceQuery(7)).toBe('&device=7');
    expect(deviceQuery(0)).toBe('&device=0');
    expect(deviceQuery(null)).toBe('');
  });
});

describe('measurementsLoadOf', () => {
  const rows = [{ last_fetched: '2026-11-01T00:00:00Z', samples: [1, 2] }];

  it('reads rows, total, devices and the shown device', () => {
    expect(
      measurementsLoadOf({
        measurements: rows as never,
        total: '12',
        devices: [{ id: 3, display_name: 'A' }],
        device: 3,
      }),
    ).toEqual({
      rows,
      total: 12,
      devices: [{ id: 3, display_name: 'A' }],
      device: 3,
    });
  });

  it('defaults to the rows as total and no devices', () => {
    expect(measurementsLoadOf({ measurements: rows as never })).toEqual({
      rows,
      total: 1,
      devices: [],
      device: null,
    });
    expect(measurementsLoadOf(undefined)).toEqual({
      rows: [],
      total: 0,
      devices: [],
      device: null,
    });
    expect(measurementRowsOf(null)).toEqual([]);
  });
});

describe('heatmapComplete', () => {
  const heatmap = (total: number | undefined, frames: number) =>
    ({
      data: {},
      timestamps: Array.from({ length: frames }, (_, index) => index),
      total,
    }) as SensorHeatmapResponse;

  it('holds the period when it has every frame', () => {
    expect(heatmapComplete(heatmap(3, 3))).toBe(true);
    expect(heatmapComplete(heatmap(undefined, 3))).toBe(true);
    expect(heatmapComplete(heatmap(4, 3))).toBe(false);
  });
});

describe('rememberLoad / recallLoad', () => {
  it('serves a kept period again, cut shorter ones from complete loads', () => {
    const cache: LoadCache<string> = new Map();
    const cut = (value: string, fromMs: number) =>
      `${value} from ${fromMs > 0}`;
    expect(recallLoad(cache, 'a', 7, 300, cut)).toBeNull();
    rememberLoad(cache, 'a', {
      days: 30,
      limit: 300,
      complete: true,
      value: '30d',
    });
    expect(recallLoad(cache, 'a', 30, 300, cut)).toBe('30d');
    expect(recallLoad(cache, 'a', 7, 300, cut)).toBe('30d from true');
    expect(recallLoad(cache, 'b', 30, 300, cut)).toBeNull();
    expect(cache.get('a')?.[0].loadedAt).toBeGreaterThan(0);
  });
});
