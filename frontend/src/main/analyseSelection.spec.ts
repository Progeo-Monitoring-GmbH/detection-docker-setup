import { describe, expect, it } from 'vitest';
import {
  planAreaPick,
  planSensorPick,
  selectedPositionsOf,
  sensorThresholdsOf,
  withSensor,
} from './analyseSelection';

// Device 10 measures pairs 1-2 (pos 1, 2), device 20 pair 1 (pos 3); pos 4
// has no device (counts for every one), pos 5 no pair (pos is the pair).
const points = [
  { pos: 1, device: 10, pair: 1, threshold: 5 },
  { pos: 2, device: 10, pair: 2 },
  { pos: 3, device: 20, pair: 1, threshold: 7 },
  { pos: 4, device: null, pair: 3 },
  { pos: 5, device: 10, pair: null, threshold: 9 },
];

describe('selectedPositionsOf', () => {
  it('is the plan positions of the selected pairs of the shown device', () => {
    expect(selectedPositionsOf(points, [0, 2], 10)).toEqual([1, 4]);
    expect(selectedPositionsOf(points, [0], 20)).toEqual([3]);
    expect(selectedPositionsOf(points, [4], 10)).toEqual([5]);
    expect(selectedPositionsOf(points, [], 10)).toEqual([]);
  });
});

describe('sensorThresholdsOf', () => {
  it('maps the pairs of the shown device to their own thresholds', () => {
    expect([...sensorThresholdsOf(points, 10)]).toEqual([
      [0, 5],
      [4, 9],
    ]);
    expect([...sensorThresholdsOf(points, 20)]).toEqual([[0, 7]]);
  });
});

describe('withSensor', () => {
  it('adds the pair sorted, keeps the selection when it is in', () => {
    expect(withSensor([0, 3], 1)).toEqual([0, 1, 3]);
    const selected = [0, 1];
    expect(withSensor(selected, 1)).toBe(selected);
  });
});

describe('planAreaPick', () => {
  it('selects the pairs of the shown device', () => {
    expect(planAreaPick(points, [2, 1, 4, 3], 10, [10, 20])).toEqual({
      device: null,
      pairs: [0, 1, 2],
    });
  });

  it('else the first other device of the location, shown then', () => {
    expect(planAreaPick(points, [3], 10, [10, 20])).toEqual({
      device: 20,
      pairs: [0],
    });
  });

  it('is null when no sensor belongs to a device of the location', () => {
    expect(planAreaPick(points, [3], 10, [10])).toBeNull();
    expect(planAreaPick(points, [], 10, [10, 20])).toBeNull();
  });

  it('counts positions without a point as pairs of every device', () => {
    expect(planAreaPick(points, [9], 10, [10])).toEqual({
      device: null,
      pairs: [8],
    });
  });
});

describe('planSensorPick', () => {
  it('is the pair of a sensor of the shown device', () => {
    expect(planSensorPick(points, 2, 10, [10, 20])).toEqual({
      device: null,
      pair: 1,
    });
    expect(planSensorPick(points, 4, 20, [10, 20])).toEqual({
      device: null,
      pair: 2,
    });
  });

  it('names another device of the location to show', () => {
    expect(planSensorPick(points, 3, 10, [10, 20])).toEqual({
      device: 20,
      pair: 0,
    });
  });

  it('keeps the shown device for a device not of the location', () => {
    expect(planSensorPick(points, 3, 10, [10])).toEqual({
      device: null,
      pair: 0,
    });
    expect(planSensorPick(points, 8, 10, [10])).toEqual({
      device: null,
      pair: 7,
    });
  });
});
