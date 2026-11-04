import { describe, expect, it } from 'vitest';
import { COMPARE_OFFSETS, compareOffsetsFor, heatmapChange, nearestIndex } from './analyseCompare';
import { barWidthFor, nearestRow, sensorChanges, signedBands, wpChangeBands } from '../components/device/measurementBands';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 4, 12);

describe('compareOffsetsFor', () => {
  it('offers only offsets whose shifted period has data', () => {
    // Data from 40 days ago on, a 7 day period: up to 33 days back.
    const first = new Date(NOW - 40 * DAY).toISOString();
    expect(compareOffsetsFor(first, 7, NOW).map((offset) => offset.key)).toEqual(['1d', '7d', '14d', '1m']);
    expect(compareOffsetsFor(first, 30, NOW).map((offset) => offset.key)).toEqual(['1d', '7d']);
  });

  it('offers everything with old enough data, nothing without', () => {
    expect(compareOffsetsFor(new Date(NOW - 1000 * DAY).toISOString(), 30, NOW)).toEqual([...COMPARE_OFFSETS]);
    expect(compareOffsetsFor(null, 7, NOW)).toEqual([]);
  });
});

describe('nearestIndex', () => {
  it('finds the nearest time', () => {
    expect(nearestIndex([0, 10, 20], 4)).toBe(0);
    expect(nearestIndex([0, 10, 20], 6)).toBe(1);
    expect(nearestIndex([0, 10, 20], 99)).toBe(2);
    expect(nearestIndex([0, 10, 20], -5)).toBe(0);
    expect(nearestIndex([], 5)).toBe(-1);
  });
});

describe('heatmapChange', () => {
  it("subtracts each sensor's value at the shifted time", () => {
    const offset = 7 * DAY;
    const current = { timestamps: [1000, 2000], data: { '1': [10, 20], '2': [5, null] } };
    const shift = offset / 1000;
    const past = { timestamps: [1000 - shift, 2010 - shift], data: { '1': [4, 30], '2': [1, 1] } };
    expect(heatmapChange(current, past, offset)).toEqual({
      timestamps: [1000, 2000],
      data: { '1': [6, -10], '2': [4, null] },
    });
    expect(heatmapChange(current, null, offset)).toBeNull();
  });
});

describe('signedBands / nearestRow', () => {
  const row = (minute: number, samples: number[]) => ({
    last_fetched: new Date(Date.UTC(2026, 10, 4, 12, minute)).toISOString(),
    samples,
  });

  it('gives mean, deviation and range of WP - EP per sensor, numbered from 1', () => {
    const bands = signedBands([row(0, [0, 2, 5, 5]), row(1, [0, 4, 5, 3])]);
    expect(bands.x).toEqual([1, 2]);
    expect(bands.mean).toEqual([3, -1]);
    expect(bands.sigma).toEqual([1, 1]);
    expect(bands.min).toEqual([2, -2]);
    expect(bands.max).toEqual([4, 0]);
  });

  it('picks the measurement nearest in time, the newest without one', () => {
    const rows = [row(10, []), row(0, []), row(5, [])];
    expect(nearestRow(rows, Date.UTC(2026, 10, 4, 12, 4))).toBe(rows[2]);
    expect(nearestRow(rows, null)).toBe(rows[0]);
    expect(nearestRow([], null)).toBeNull();
  });
});

describe('wpChangeBands', () => {
  const at = (day: number, samples: number[]) => ({
    last_fetched: new Date(NOW + day * DAY).toISOString(),
    samples,
  });

  it("gives the bands of each measurement's WP change since the one an offset earlier", () => {
    // [EP, WP] of one sensor: now (day 0, 1) WP 5 and 9; 7 days earlier WP 4 and 6.
    const rows = [at(0, [0, 5]), at(1, [0, 9])];
    const pastRows = [at(-7, [0, 4]), at(-6, [0, 6])];
    const bands = wpChangeBands(rows, pastRows, 7 * DAY);
    // Changes: 5 - 4 = 1 and 9 - 6 = 3.
    expect(bands.x).toEqual([1]);
    expect(bands.mean).toEqual([2]);
    expect(bands.sigma).toEqual([1]);
    expect([bands.min, bands.max]).toEqual([[1], [3]]);
    expect(wpChangeBands(rows, [], 7 * DAY).x).toEqual([]);
  });
});

describe('sensorChanges', () => {
  it('lists the change of WP and EP per sensor, biggest first', () => {
    // [EP, WP] per sensor: then (1, 1), (5, 5), (0, 0); now (1, 2), (2, 5), (0, 0).
    const changes = sensorChanges([1, 2, 2, 5, 0, 0], [1, 1, 5, 5, 0, 0, 9]);
    expect(changes.map((change) => [change.sensor, change.wpChange, change.epChange])).toEqual([
      [1, 0, -3],
      [0, 1, 0],
      [2, 0, 0],
    ]);
    expect(changes[0]).toMatchObject({ epThen: 5, epNow: 2, wpThen: 5, wpNow: 5 });
    expect(sensorChanges([1, 2], null)).toEqual([]);
  });
});

describe('barWidthFor', () => {
  it('sizes the bars by the typical spacing - a gap or a close pair does not change it', () => {
    // Hourly, one pair a minute apart, one 5 hour gap.
    const hour = 3_600_000;
    const times = [0, hour, hour + 60_000, 2 * hour, 7 * hour, 8 * hour];
    expect(barWidthFor(times)).toBe(0.8 * hour);
    expect(barWidthFor([5])).toBeUndefined();
  });
});
