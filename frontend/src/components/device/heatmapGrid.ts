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
 * The normalized range [lo, hi] the grid covers on both axes (the same on
 * both: the cells stay square, the kernels round). The unit square by
 * default - sensors placed beside the plan (e.g. aligned in the Lageplan
 * wizard) lie outside it, see gridDomain.
 */
export type GridDomain = { lo: number; hi: number };

export const UNIT_DOMAIN: GridDomain = { lo: 0, hi: 1 };

/** How far beyond the unit square the grid follows the sensors - a stray
 * point far off the plan must not stretch the grid over nothing. */
const DOMAIN_LIMIT = 2;

/** The range covering the unit square and the coordinates (sensor x / y,
 * band ends) - at most DOMAIN_LIMIT beyond it. */
export const gridDomain = (coordinates: number[]): GridDomain => {
  const finite = coordinates.filter(Number.isFinite);
  return {
    lo: Math.max(Math.min(0, ...finite), -DOMAIN_LIMIT),
    hi: Math.min(Math.max(1, ...finite), 1 + DOMAIN_LIMIT),
  };
};

/** Regular grid over [lo - pad, hi + pad] with `resolution` (at least 2)
 * points per axis; `cell` is the normalized length of one grid cell. */
export const gridAxis = (resolution: number, pad: number, domain: GridDomain = UNIT_DOMAIN) => {
  const res = Math.max(2, resolution);
  const origin = domain.lo - pad;
  const span = domain.hi - domain.lo + 2 * pad;
  const cell = span / (res - 1);
  const axis = Array.from({ length: res }, (_, index) => origin + index * cell);
  return { res, span, cell, axis, origin };
};

/** Grid position of a point (clamped to the grid's domain) and the cells
 * within `radiusCells` around it. */
const kernelWindow = (
  point: WeightedPoint,
  domain: GridDomain,
  origin: number,
  cell: number,
  res: number,
  radiusCells: number,
) => {
  const cx = (clamp(point.x, domain.lo, domain.hi) - origin) / cell;
  const cy = (clamp(point.y, domain.lo, domain.hi) - origin) / cell;
  return {
    cx,
    cy,
    startX: Math.max(0, Math.floor(cx - radiusCells)),
    endX: Math.min(res - 1, Math.ceil(cx + radiusCells)),
    startY: Math.max(0, Math.floor(cy - radiusCells)),
    endY: Math.min(res - 1, Math.ceil(cy + radiusCells)),
  };
};

/**
 * Weighted Gaussian splatting on a regular grid over [lo - pad, hi + pad]^2
 * (the domain, by default the unit square) - the padding lets the heat of
 * sensors on the border fade out instead of being cut off at the outermost
 * points:
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
  domain: GridDomain = UNIT_DOMAIN,
) => {
  const { res, span, cell, axis, origin } = gridAxis(resolution, pad, domain);
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

    const { cx, cy, startX, endX, startY, endY } = kernelWindow(
      point,
      domain,
      origin,
      cell,
      res,
      radiusCells,
    );

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

/** Kernel weight below which a sensor no longer contributes to the field
 * (about 3 sigma), and the weight from which the field is fully opaque. */
const FIELD_CUTOFF = 0.011;
const FIELD_OPAQUE = 0.3;

/**
 * Interpolated field of readings that don't add up - e.g. humidity or
 * temperature (LoRaWAN), where two sensors side by side are not "hotter"
 * than one: every cell holds the Gaussian-weighted mean of the sensors
 *
 *   value(x) = sum_i k_i(x) * v_i / sum_i k_i(x),  k_i = exp(-d^2 / (2 sigma^2))
 *
 * scaled from [range.min, range.max] to [0, 1]. `coverage` (0..1) fades the
 * field out away from the sensors: 1 up to ~1.5 sigma from the nearest one,
 * 0 beyond ~3 sigma, where there is nothing to interpolate.
 */
export const buildFieldGrid = (
  points: WeightedPoint[],
  resolution: number,
  sigma: number,
  range: { min: number; max: number },
  pad = 0,
  domain: GridDomain = UNIT_DOMAIN,
) => {
  const { res, span, cell, axis, origin } = gridAxis(resolution, pad, domain);
  const weighted = Array.from({ length: res }, () => new Float64Array(res));
  const weights = Array.from({ length: res }, () => new Float64Array(res));
  const nearest = Array.from({ length: res }, () => new Float64Array(res));

  const twoSigmaSquared = 2 * sigma * sigma;
  const radius = Math.sqrt(twoSigmaSquared * Math.log(1 / FIELD_CUTOFF));
  const radiusCells = Math.ceil(Math.min(radius, span) / cell);

  points.forEach((point) => {
    if (!Number.isFinite(point.weight)) {
      return;
    }
    const { cx, cy, startX, endX, startY, endY } = kernelWindow(
      point,
      domain,
      origin,
      cell,
      res,
      radiusCells,
    );

    for (let gy = startY; gy <= endY; gy += 1) {
      const dy = (gy - cy) * cell;
      for (let gx = startX; gx <= endX; gx += 1) {
        const dx = (gx - cx) * cell;
        const kernel = Math.exp(-(dx * dx + dy * dy) / twoSigmaSquared);
        if (kernel < FIELD_CUTOFF) {
          continue;
        }
        weighted[gy][gx] += kernel * point.weight;
        weights[gy][gx] += kernel;
        nearest[gy][gx] = Math.max(nearest[gy][gx], kernel);
      }
    }
  });

  const extent = range.max - range.min;
  const grid = weighted.map((row, gy) =>
    row.map((sum, gx) => {
      const weight = weights[gy][gx];
      if (weight <= 0) {
        return 0;
      }
      return extent > 0 ? clamp((sum / weight - range.min) / extent, 0, 1) : 0.5;
    }),
  );
  const coverage = nearest.map((row) =>
    row.map((kernel) =>
      clamp((kernel - FIELD_CUTOFF) / (FIELD_OPAQUE - FIELD_CUTOFF), 0, 1),
    ),
  );

  return { axis, grid, coverage };
};

/** [min, max] of all finite values of the series (the colour scale of a
 * field heatmap, the same for every frame); widened by `minSpan` around its
 * middle when the values hardly differ. Null without any value. */
export const seriesRange = (
  series: Array<ArrayLike<number | null>>,
  minSpan = 1,
): { min: number; max: number } | null => {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  series.forEach((values) => {
    for (let index = 0; index < values.length; index += 1) {
      const value = values[index];
      if (value != null && Number.isFinite(value)) {
        min = Math.min(min, value);
        max = Math.max(max, value);
      }
    }
  });
  if (!Number.isFinite(min)) {
    return null;
  }
  if (max - min < minSpan) {
    const middle = (min + max) / 2;
    return { min: middle - minSpan / 2, max: middle + minSpan / 2 };
  }
  return { min, max };
};
