import { describe, expect, it } from 'vitest';
import { movingMean, smoothHeatmap, smoothMeasurements } from './analyseSmoothing';

describe('movingMean', () => {
  it('averages the neighbours centred on each value, fewer at the ends', () => {
    expect(movingMean([0, 3, 6, 9], 3)).toEqual([1.5, 3, 6, 7.5]);
  });

  it('leaves the values as they are with window 1', () => {
    expect(movingMean([1, null, 3], 1)).toEqual([1, null, 3]);
  });

  it('skips missing values and keeps them missing', () => {
    expect(movingMean([2, null, 4, 6], 3)).toEqual([2, null, 5, 5]);
  });

  it('takes one more neighbour after than before for an even window', () => {
    // window 4: one before, two after.
    expect(movingMean([0, 4, 8, 12, 16], 4)).toEqual([4, 6, 10, 12, 14]);
  });
});

describe('smoothHeatmap', () => {
  it('smooths every series, keeps the frames', () => {
    const heatmap = { timestamps: [1, 2, 3], data: { '1': [0, 3, 6], '2': [null, 1, 1] } };
    expect(smoothHeatmap(heatmap, 3)).toEqual({
      timestamps: [1, 2, 3],
      data: { '1': [1.5, 3, 4.5], '2': [null, 1, 1] },
    });
    expect(smoothHeatmap(heatmap, 1)).toBe(heatmap);
  });
});

describe('smoothMeasurements', () => {
  const row = (id: number, minute: number, samples: number[], pairs?: number[]) => ({
    id,
    device: 1,
    last_fetched: new Date(Date.UTC(2026, 10, 4, 12, minute)).toISOString(),
    samples,
    ...(pairs ? { pair_abs_values: pairs } : {}),
  });

  it('smooths samples and pair values in time order, keeping the rows in theirs', () => {
    // Newest first, as the backend sends them.
    const rows = [row(3, 2, [6, 60], [54]), row(2, 1, [3, 30], [27]), row(1, 0, [0, 0], [0])];
    const smoothed = smoothMeasurements(rows, 3);
    expect(smoothed.map((entry) => entry.id)).toEqual([3, 2, 1]);
    expect(smoothed.map((entry) => entry.samples)).toEqual([
      [4.5, 45],
      [3, 30],
      [1.5, 15],
    ]);
    expect(smoothed.map((entry) => entry.pair_abs_values)).toEqual([[40.5], [27], [13.5]]);
  });

  it('copes with rows of different lengths and without pair values', () => {
    const rows = [row(1, 0, [2, 4]), row(2, 1, [4, 8, 1, 1])];
    const smoothed = smoothMeasurements(rows, 2);
    expect(smoothed[0].samples).toEqual([3, 6]);
    expect(smoothed[1].samples).toEqual([4, 8, 1, 1]);
    expect('pair_abs_values' in smoothed[0]).toBe(false);
  });
});
