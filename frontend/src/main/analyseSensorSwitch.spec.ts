import { describe, expect, it } from 'vitest';
import { disabledPairsOf, overrideKey, sensorOrderOf } from './analyseSensorSwitch';

// Two devices: device 7 has sensor_order 1..2 as its pairs 1..2, device 8 sensor_order 3..4 as its pairs 1..2.
const POINTS = [
  { pos: 1, device: 7, pair: 1 },
  { pos: 2, device: 7, pair: 2, disabled: true },
  { pos: 3, device: 8, pair: 1, disabled: true },
  { pos: 4, device: 8, pair: 2 },
];

describe('sensorOrderOf', () => {
  it("maps the shown device's pair to the location's sensor_order", () => {
    expect(sensorOrderOf(POINTS, 7, 1, 2)).toBe(2);
    expect(sensorOrderOf(POINTS, 8, 0, 2)).toBe(3);
  });

  it('counts sensors like pairs on a single-device location without a point', () => {
    expect(sensorOrderOf([], 7, 4, 1)).toBe(5);
    expect(sensorOrderOf([{ pos: 1 }], null, 0, 1)).toBe(1);
  });

  it('gives up without a point when the location has several devices', () => {
    expect(sensorOrderOf(POINTS, 8, 5, 2)).toBeNull();
  });
});

describe('disabledPairsOf', () => {
  it("lists the shown device's disabled pairs", () => {
    expect([...disabledPairsOf(POINTS, 1, 7, {})]).toEqual([1]);
    expect([...disabledPairsOf(POINTS, 1, 8, {})]).toEqual([0]);
  });

  it("puts the page's switches on top - only of this location and device", () => {
    const overrides = {
      [overrideKey(1, 7, 0)]: true,
      [overrideKey(1, 7, 1)]: false,
      [overrideKey(1, 8, 1)]: true,
      [overrideKey(2, 7, 3)]: true,
      // "1:70:..." must not count for device 7.
      [overrideKey(1, 70, 5)]: true,
    };
    expect([...disabledPairsOf(POINTS, 1, 7, overrides)]).toEqual([0]);
    expect([...disabledPairsOf(POINTS, 1, 8, overrides)].sort()).toEqual([0, 1]);
  });
});
