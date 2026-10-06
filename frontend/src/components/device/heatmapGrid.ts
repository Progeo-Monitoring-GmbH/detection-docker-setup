/**
 * Heat field of the 2D sensor heatmap (extracted from SensorHeatmap2D so it
 * can be tested without plotly/React).
 */

export type WeightedPoint = {
  pos: number;
  x: number;
  y: number;
  weight: number;
};

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

/** Heat (fraction of the scale) below which a kernel is no longer drawn. */
const HEAT_CUTOFF = 0.001;

/**
 * Weighted Gaussian splatting on a regular grid over [-pad, 1 + pad]^2 - the
 * padding lets the heat of sensors on the border fade out instead of being
 * cut off at the outermost points:
 *
 *   heat(x) = sum_i weight_i * exp(-d(x, point_i)^2 / (2 * sigma^2))
 *
 * Each sensor's kernel is evaluated out to the distance where its heat drops
 * below HEAT_CUTOFF of the scale (reference, else the largest reading) - not
 * a fixed 3 sigma: a reading far above the reference is still saturated at
 * 3 sigma, and cutting it off there drew hard straight edges.
 *
 * When `referenceMax` is given (absolute scaling), the accumulated field is
 * divided by it and clamped to [0, 1] - heat only reaches 1 for sensor
 * values far above the alarm threshold. Without it the field is normalized
 * by its own maximum (relative fallback).
 */
export const buildWeightedGrid = (
  points: WeightedPoint[],
  resolution: number,
  sigma: number,
  referenceMax: number | null = null,
  pad = 0,
) => {
  const res = Math.max(2, resolution);
  const span = 1 + 2 * pad;
  // Normalized length of one grid cell.
  const cell = span / (res - 1);
  const axis = Array.from({ length: res }, (_, index) => -pad + index * cell);
  const grid = Array.from({ length: res }, () => new Float64Array(res));

  const twoSigmaSquared = 2 * sigma * sigma;
  const largestWeight = points.reduce(
    (largest, point) =>
      Number.isFinite(point.weight) ? Math.max(largest, point.weight) : largest,
    0,
  );
  const scale =
    referenceMax != null && referenceMax > 0 ? referenceMax : largestWeight;
  const cutoff = scale * HEAT_CUTOFF;

  points.forEach((point) => {
    if (!Number.isFinite(point.weight) || point.weight <= cutoff) {
      return;
    }

    // weight * exp(-r^2 / (2 sigma^2)) = cutoff, solved for r.
    const radius = Math.sqrt(twoSigmaSquared * Math.log(point.weight / cutoff));
    const radiusCells = Math.ceil(Math.min(radius, span) / cell);

    const cx = (clamp(point.x, 0, 1) + pad) / cell;
    const cy = (clamp(point.y, 0, 1) + pad) / cell;
    const startX = Math.max(0, Math.floor(cx - radiusCells));
    const endX = Math.min(res - 1, Math.ceil(cx + radiusCells));
    const startY = Math.max(0, Math.floor(cy - radiusCells));
    const endY = Math.min(res - 1, Math.ceil(cy + radiusCells));

    for (let gy = startY; gy <= endY; gy += 1) {
      const dyNormalized = (gy - cy) * cell;
      for (let gx = startX; gx <= endX; gx += 1) {
        const dxNormalized = (gx - cx) * cell;
        const distanceSquared =
          dxNormalized * dxNormalized + dyNormalized * dyNormalized;
        const kernel = Math.exp(-distanceSquared / twoSigmaSquared);
        grid[gy][gx] += point.weight * kernel;
      }
    }
  });

  let max = 0;
  grid.forEach((row) => {
    row.forEach((value) => {
      if (value > max) {
        max = value;
      }
    });
  });

  if (referenceMax != null && referenceMax > 0) {
    grid.forEach((row) => {
      for (let index = 0; index < row.length; index += 1) {
        row[index] = clamp(row[index] / referenceMax, 0, 1);
      }
    });
  } else if (max > 0) {
    grid.forEach((row) => {
      for (let index = 0; index < row.length; index += 1) {
        row[index] /= max;
      }
    });
  }

  return { axis, grid, max };
};
