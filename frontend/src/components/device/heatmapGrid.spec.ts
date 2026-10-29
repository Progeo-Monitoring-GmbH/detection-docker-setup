import { describe, expect, it } from 'vitest';
import { buildFieldGrid, buildWeightedGrid, seriesRange } from './heatmapGrid';

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

describe('buildFieldGrid', () => {
  const at = (axis: number[], value: number) =>
    axis.reduce(
      (best, current, index) =>
        Math.abs(current - value) < Math.abs(axis[best] - value) ? index : best,
      0,
    );

  it('interpolates between sensors instead of adding them up', () => {
    const { axis, grid, coverage } = buildFieldGrid(
      [
        { pos: 1, x: 0.4, y: 0.5, weight: 40 },
        { pos: 2, x: 0.6, y: 0.5, weight: 60 },
      ],
      101,
      0.1,
      { min: 40, max: 60 },
    );
    const row = at(axis, 0.5);

    expect(grid[row][at(axis, 0.4)]).toBeLessThan(0.5);
    expect(grid[row][at(axis, 0.5)]).toBeCloseTo(0.5, 5);
    expect(grid[row][at(axis, 0.6)]).toBeGreaterThan(0.5);
    // Between two sensors the field is no "hotter" than at the warmer one.
    expect(Math.max(...grid[row])).toBeLessThanOrEqual(1);
    expect(coverage[row][at(axis, 0.5)]).toBe(1);
  });

  it('fades out away from the sensors', () => {
    const { axis, coverage } = buildFieldGrid(
      [{ pos: 1, x: 0.5, y: 0.5, weight: 20 }],
      101,
      0.05,
      { min: 0, max: 40 },
    );
    const row = at(axis, 0.5);

    expect(coverage[row][at(axis, 0.5)]).toBe(1);
    expect(coverage[row][at(axis, 0.6)]).toBeGreaterThan(0);
    expect(coverage[row][at(axis, 0.6)]).toBeLessThan(1);
    expect(coverage[row][at(axis, 0.9)]).toBe(0);
  });

  it('keeps negative readings (temperatures below zero)', () => {
    const { axis, grid } = buildFieldGrid(
      [{ pos: 1, x: 0.5, y: 0.5, weight: -5 }],
      21,
      0.1,
      { min: -10, max: 10 },
    );

    expect(grid[at(axis, 0.5)][at(axis, 0.5)]).toBeCloseTo(0.25, 5);
  });
});

describe('seriesRange', () => {
  it('spans every finite value, ignoring gaps', () => {
    expect(seriesRange([[3, null, 7], [Number.NaN, -2]])).toEqual({ min: -2, max: 7 });
  });

  it('widens a flat range and has none without values', () => {
    expect(seriesRange([[20, 20.2]], 1)).toEqual({ min: 19.6, max: 20.6 });
    expect(seriesRange([[null]])).toBeNull();
  });
});
