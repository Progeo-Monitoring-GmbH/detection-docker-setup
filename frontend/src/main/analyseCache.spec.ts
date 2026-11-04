import { describe, expect, it } from 'vitest';
import {
  CACHE_MAX_AGE_MS,
  type CachedLoad,
  cachedPeriod,
  cutHeatmap,
  cutMeasurements,
  type MeasurementsLoad,
  withLoad,
} from './analyseCache';

const NOW = Date.UTC(2026, 10, 4, 12);
const DAY = 24 * 60 * 60 * 1000;

const load = (days: number, complete: boolean, loadedAt = NOW, limit = 300): CachedLoad<string> => ({
  days,
  limit,
  complete,
  loadedAt,
  value: `${days}`,
});
const cut = (value: string, fromMs: number) => `${value} from ${(NOW - fromMs) / DAY}d`;

describe('cachedPeriod', () => {
  it('reuses a period loaded before', () => {
    expect(cachedPeriod([load(90, false)], 90, 300, NOW, cut)).toBe('90');
  });

  it('reuses a thinned load only at its own resolution, a complete one at any', () => {
    expect(cachedPeriod([load(90, false)], 90, 1000, NOW, cut)).toBeNull();
    expect(cachedPeriod([load(7, true)], 7, 1000, NOW, cut)).toBe('7');
  });

  it('cuts a shorter period out of the shortest complete longer load', () => {
    expect(cachedPeriod([load(90, true), load(30, true)], 7, 300, NOW, cut)).toBe('30 from 7d');
  });

  it('does not cut out of a thinned load', () => {
    expect(cachedPeriod([load(90, false)], 7, 300, NOW, cut)).toBeNull();
  });

  it('does not reuse expired loads', () => {
    expect(cachedPeriod([load(7, true, NOW - CACHE_MAX_AGE_MS)], 7, 300, NOW, cut)).toBeNull();
  });

  it('has nothing for a longer period', () => {
    expect(cachedPeriod([load(7, true)], 30, 300, NOW, cut)).toBeNull();
  });
});

describe('withLoad', () => {
  it('replaces the load of the same period and resolution and drops expired ones', () => {
    const loads = withLoad(
      [load(7, false), load(7, false, NOW, 1000), load(30, true, NOW - CACHE_MAX_AGE_MS)],
      load(7, true),
      NOW,
    );
    expect(loads).toEqual([load(7, false, NOW, 1000), load(7, true)]);
  });
});

describe('cutHeatmap', () => {
  it('keeps the frames from the start on, with their values', () => {
    const seconds = (ms: number) => ms / 1000;
    const heatmap = {
      timestamps: [seconds(NOW - 3 * DAY), seconds(NOW - DAY), seconds(NOW)],
      data: { '1': [1, 2, 3], '2': [null, 5, 6] },
      total: 3,
    };
    expect(cutHeatmap(heatmap, NOW - 2 * DAY)).toEqual({
      timestamps: [seconds(NOW - DAY), seconds(NOW)],
      data: { '1': [2, 3], '2': [5, 6] },
      total: 2,
    });
  });
});

describe('cutMeasurements', () => {
  it('keeps the rows from the start on', () => {
    const row = (id: number, ms: number) => ({ id, device: 1, last_fetched: new Date(ms).toISOString(), samples: [] });
    const measurements: MeasurementsLoad = {
      rows: [row(3, NOW), row(2, NOW - DAY), row(1, NOW - 3 * DAY)],
      total: 3,
      devices: [],
      device: 1,
    };
    const result = cutMeasurements(measurements, NOW - 2 * DAY);
    expect(result.rows.map((entry) => entry.id)).toEqual([3, 2]);
    expect(result.total).toBe(2);
  });
});
