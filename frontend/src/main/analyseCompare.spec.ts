import { describe, expect, it } from 'vitest';
import { COMPARE_OFFSETS, compareOffsetsFor, heatmapChange, nearestIndex } from './analyseCompare';
import { nearestRow, signedBands } from '../components/device/measurementBands';

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
