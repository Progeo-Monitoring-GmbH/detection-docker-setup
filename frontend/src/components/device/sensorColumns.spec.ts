import { describe, expect, it } from 'vitest';
import {
  columnSlots,
  columnWidthOf,
  MAX_COLUMN,
  MIN_COLUMN,
  niceTicks,
  peakOf,
  type SensorSpread,
  shownSensors,
} from './sensorColumns';

const spread: SensorSpread = {
  min: [-40, 5, -1, 0],
  max: [10, 80, 1, 3],
  lower: [0, 0, 0, 0],
  upper: [0, 0, 0, 0],
  mean: [0, 0, 0, 0],
  sigma: [0, 0, 0, 0],
};

describe('peakOf / shownSensors', () => {
  it('compares the highest |WP − EP| of the period, below as above zero', () => {
    expect([0, 1, 2, 3].map((sensor) => peakOf(spread, sensor))).toEqual([40, 80, 1, 3]);
  });

  it('hides the sensors below the level - never a followed one, nothing at level 0', () => {
    expect(shownSensors(4, spread, 0, [])).toEqual([0, 1, 2, 3]);
    expect(shownSensors(4, spread, 5, [])).toEqual([0, 1]);
    expect(shownSensors(4, spread, 5, [2])).toEqual([0, 1, 2]);
    expect(shownSensors(4, spread, 100, [])).toEqual([]);
  });
});

describe('columnWidthOf', () => {
  it('keeps 4 sensors slim and 300 readable (then the plot scrolls)', () => {
    expect(columnWidthOf(800, 4, null)).toBe(MAX_COLUMN);
    expect(columnWidthOf(800, 300, null)).toBe(MIN_COLUMN);
    expect(columnWidthOf(800, 40, null)).toBe(20);
  });

  it('follows the Ctrl + wheel zoom - out down to all sensors at once', () => {
    // Never below fitting all of them (3 px at the least).
    expect(columnWidthOf(800, 300, 1)).toBe(3);
    expect(columnWidthOf(800, 300, 4)).toBe(4);
    expect(columnWidthOf(800, 40, 50)).toBe(50);
    expect(columnWidthOf(800, 40, 500)).toBe(MAX_COLUMN);
  });
});

describe('columnSlots', () => {
  it('puts the spread left and the bars right, without overlap', () => {
    const { spread: box, bars } = columnSlots(true, ['ep', 'wp']);
    expect(box![1]).toBeLessThan(bars[0].from);
    expect(bars[0].to).toBeLessThanOrEqual(bars[1].from);
    expect(bars[1].to).toBeLessThanOrEqual(0.88);
  });

  it('gives either part the whole column alone', () => {
    expect(columnSlots(true, []).spread).toEqual([0.12, 0.88]);
    expect(columnSlots(false, ['ep']).bars[0]).toEqual({ key: 'ep', from: 0.12, to: 0.88 });
  });
});

describe('niceTicks', () => {
  it('spans negative and positive values in round steps with 0 among them', () => {
    expect(niceTicks(-100, 100)).toEqual([-100, -50, 0, 50, 100]);
    expect(niceTicks(-40, 100)).toEqual([0, 50, 100]);
    expect(niceTicks(0, 1)).toContain(0);
  });
});
