import { describe, expect, it } from 'vitest';
import { buildWeightedGrid } from './heatmapGrid';

/** Largest difference between horizontally/vertically adjacent cells. */
const largestStep = (grid: Float64Array[]) => {
  let step = 0;
  grid.forEach((row, y) => {
    row.forEach((value, x) => {
      if (x > 0) {
        step = Math.max(step, Math.abs(value - row[x - 1]));
      }
      if (y > 0) {
        step = Math.max(step, Math.abs(value - grid[y - 1][x]));
      }
    });
  });
  return step;
};

describe('buildWeightedGrid', () => {
  it('fades out a reading far above the saturation level instead of cutting it off', () => {
    // 10000 mV against heat=1 at 300 mV: a fixed 3 sigma window cut the
    // kernel off while it was still at heat ~0.37 - a hard straight edge.
    const weight = 10000;
    const sigma = 0.05;
    const { grid } = buildWeightedGrid(
      [{ pos: 1, x: 0.5, y: 0.5, weight }],
      101,
      sigma,
      300,
    );

    // Along the centre row the field must follow the exact (clamped)
    // Gaussian - cell distance d is d * 0.01 in normalized units.
    grid[50].forEach((value, x) => {
      const distance = (x - 50) * 0.01;
      const exact = Math.min(
        1,
        (weight * Math.exp(-(distance * distance) / (2 * sigma * sigma))) / 300,
      );
      expect(value).toBeCloseTo(exact, 2);
    });
    expect(grid[50][50]).toBe(1);
  });

  it('keeps moderate readings unchanged', () => {
    const { grid } = buildWeightedGrid(
      [{ pos: 1, x: 0.5, y: 0.5, weight: 150 }],
      101,
      0.05,
      300,
    );

    expect(grid[50][50]).toBeCloseTo(0.5, 5);
    // One sigma (5 cells) away: 0.5 * exp(-1/2).
    expect(grid[50][55]).toBeCloseTo(0.5 * Math.exp(-0.5), 5);
    expect(largestStep(grid)).toBeLessThan(0.1);
  });

  it('normalizes by its own maximum without a reference', () => {
    const { grid, max } = buildWeightedGrid(
      [{ pos: 1, x: 0.5, y: 0.5, weight: 7 }],
      101,
      0.05,
    );

    expect(max).toBeCloseTo(7, 5);
    expect(grid[50][50]).toBeCloseTo(1, 5);
  });
});
