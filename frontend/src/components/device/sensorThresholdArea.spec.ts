import { describe, expect, it } from 'vitest';
import { sensorThresholdOf, thresholdAreaOf } from './sensorThresholdArea';

describe('sensorThresholdOf', () => {
  it("prefers the sensor's own threshold over the location's", () => {
    expect(sensorThresholdOf(2, 5, new Map([[2, 8]]))).toBe(8);
    expect(sensorThresholdOf(3, 5, new Map([[2, 8]]))).toBe(5);
  });

  it('ignores missing and non-positive thresholds', () => {
    expect(sensorThresholdOf(0, null, null)).toBeNull();
    expect(sensorThresholdOf(0, 0, new Map([[0, 0]]))).toBeNull();
    expect(sensorThresholdOf(0, 4, new Map([[0, -1]]))).toBe(4);
  });
});

describe('thresholdAreaOf', () => {
  it('shows the location threshold while no sensor is selected', () => {
    expect(thresholdAreaOf([], 5, null)).toEqual({ top: 5, lines: [] });
    expect(thresholdAreaOf([], null, null)).toEqual({ top: null, lines: [] });
  });

  it('is one band when the selected sensors share a threshold', () => {
    expect(thresholdAreaOf([0, 1], 5, null)).toEqual({ top: 5, lines: [] });
  });

  it('bands up to the lowest threshold and marks the higher own ones', () => {
    const own = new Map([
      [1, 9],
      [2, 3],
    ]);
    expect(thresholdAreaOf([0, 1, 2], 5, own)).toEqual({
      top: 3,
      lines: [
        { sensor: 0, value: 5 },
        { sensor: 1, value: 9 },
      ],
    });
  });

  it('leaves sensors without any threshold out', () => {
    expect(thresholdAreaOf([0, 1], null, new Map([[1, 6]]))).toEqual({
      top: 6,
      lines: [],
    });
    expect(thresholdAreaOf([0], null, null)).toEqual({ top: null, lines: [] });
  });
});
