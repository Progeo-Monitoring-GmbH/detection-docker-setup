import { describe, expect, it } from 'vitest';
import { framesOf, seriesOf } from './heatmapData';
import { baseStepFor, historyWindow, stepFits } from './heatmapSteps';
import type { SensorHeatmapResponse } from './sensorHeatmapTypes';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const at = (day: number, hour = 0, minute = 0) => new Date(2026, 6, day, hour, minute).getTime();

/** Half-hour frames of two sensors: sensor 1 counts up, sensor 2 has a spike at 05:30. */
const history = (() => {
  const timestamps: number[] = [];
  const one: Array<number | null> = [];
  const two: Array<number | null> = [];
  for (let index = 0; index < 48 * 3; index += 1) {
    if (index === 7) {
      continue; // a frame without measurement
    }
    const ms = at(1) + index * 30 * 60 * 1000;
    timestamps.push(ms / 1000);
    one.push(index);
    two.push(ms === at(1, 5, 30) ? 99 : index === 9 ? null : 1);
  }
  return { timestamps, data: { 1: one, 2: two }, step: 1800, sensor_points: [] } as SensorHeatmapResponse;
})();

describe('history', () => {
  it('loads a year in half hours and longer histories coarser', () => {
    expect(baseStepFor(at(1), at(1) + 365 * DAY)).toBe(1800);
    expect(baseStepFor(at(1), at(1) + 3 * 365 * DAY)).toBe(7200);
    expect(baseStepFor(at(1), at(1) + 10 * 365 * DAY)).toBe(86400);
  });

  it('covers the first and the last measurement', () => {
    const window = historyWindow(at(1, 9, 20), at(20, 17, 5));
    expect(window).toEqual({ from: at(1, 9), to: at(20, 17, 30), step: 1800 });
  });

  it('only groups into multiples of the loaded step', () => {
    expect(stepFits(3600, 1800)).toBe(true);
    expect(stepFits(1800, 3600)).toBe(false);
    expect(stepFits(6 * 3600, 7200)).toBe(true);
    expect(stepFits(3600, null)).toBe(true);
  });
});

describe('framesOf', () => {
  it('keeps the base frames of the window as they are', () => {
    const frames = framesOf(history, { from: at(1, 3), to: at(1, 6), step: 1800 })!;
    // 03:00 ... 05:30, without the empty 03:30 frame.
    expect(frames.timestamps.map((seconds) => new Date(seconds * 1000).getHours() * 60 + new Date(seconds * 1000).getMinutes()))
      .toEqual([180, 240, 270, 300, 330]);
    expect(frames.data[1]).toEqual([6, 8, 9, 10, 11]);
  });

  it('takes the highest value per sensor and step', () => {
    const frames = framesOf(history, { from: at(1), to: at(2), step: 6 * 3600 })!;
    expect(frames.timestamps).toEqual([at(1), at(1, 6), at(1, 12), at(1, 18)].map((ms) => ms / 1000));
    expect(frames.data[1]).toEqual([11, 23, 35, 47]);
    expect(frames.data[2]).toEqual([99, 1, 1, 1]);
  });

  it('starts day steps at midnight, whatever the window start', () => {
    const frames = framesOf(history, { from: at(1, 13), to: at(4), step: 86400 })!;
    expect(frames.timestamps).toEqual([at(1), at(2), at(3)].map((ms) => ms / 1000));
    expect(frames.data[1]).toEqual([47, 95, 143]);
  });

  it('keeps the location and points of the history', () => {
    const frames = framesOf(history, { from: at(1), to: at(2), step: 3600 })!;
    expect(frames.sensor_points).toBe(history.sensor_points);
  });
});

describe('seriesOf', () => {
  it('keeps at most the asked number of points, the highest of each', () => {
    const series = seriesOf(history, at(1), at(4), 10, 1800)!;
    expect(series.timestamps.length).toBeLessThanOrEqual(10);
    expect(Math.max(...(series.data[2] as number[]))).toBe(99);
  });
});
