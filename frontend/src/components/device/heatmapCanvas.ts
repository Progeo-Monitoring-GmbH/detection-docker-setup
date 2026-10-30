/**
 * Geometry and colours of the canvas sensor heatmap (SensorHeatmap2D), kept
 * free of React/DOM so they can be tested on their own.
 *
 * World coordinates are pixels of the Lageplan image (x right, y down - as
 * the image itself); without a plan a WORLD_FALLBACK square stands in for it.
 * The heat grid and the sensors are computed in "plot" coordinates (x the
 * fraction of the width, y up from the bottom edge), see SensorHeatmap2D.
 * The view maps world to screen pixels: screen = world * scale + translate.
 */

import { plotTheme } from '../../styles/plotTheme';

export type View = { scale: number; tx: number; ty: number };
export type WorldRect = { left: number; top: number; right: number; bottom: number };
export type WorldSize = { width: number; height: number };

/** Size of the stand-in world when there is no Lageplan image. */
export const WORLD_FALLBACK = 1000;

/** Zoom limits, relative to the scale that fits the initial view. */
export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 25;

/** Colour stops of the heat scale (0 = cold, 1 = saturated). */
const HEAT_STOPS: Array<[number, string]> = [
  [0, plotTheme.brandBlue],
  [0.35, plotTheme.contrastCyan],
  [0.65, plotTheme.contrastYellow],
  [1, plotTheme.brandOrange],
];

export const plotToWorld = (x: number, y: number, world: WorldSize): [number, number] => [
  x * world.width,
  (1 - y) * world.height,
];

export const worldToPlot = (wx: number, wy: number, world: WorldSize): [number, number] => [
  wx / world.width,
  1 - wy / world.height,
];

export const toScreen = (view: View, wx: number, wy: number): [number, number] => [
  wx * view.scale + view.tx,
  wy * view.scale + view.ty,
];

export const toWorld = (view: View, sx: number, sy: number): [number, number] => [
  (sx - view.tx) / view.scale,
  (sy - view.ty) / view.scale,
];

/** The view showing `bounds` as large as possible, centred, in a viewport of
 * width x height (minus `reservedRight` pixels on the right, e.g. a colour
 * scale). */
export const fitView = (bounds: WorldRect, width: number, height: number, reservedRight = 0): View => {
  const boundsWidth = Math.max(bounds.right - bounds.left, 1e-9);
  const boundsHeight = Math.max(bounds.bottom - bounds.top, 1e-9);
  const usableWidth = Math.max(width - reservedRight, 1);
  const scale = Math.min(usableWidth / boundsWidth, Math.max(height, 1) / boundsHeight);
  return {
    scale,
    tx: (usableWidth - boundsWidth * scale) / 2 - bounds.left * scale,
    ty: (height - boundsHeight * scale) / 2 - bounds.top * scale,
  };
};

/** Zoom by `factor` keeping the world point under (sx, sy) in place; the
 * scale stays within [minScale, maxScale]. */
export const zoomAt = (
  view: View,
  factor: number,
  sx: number,
  sy: number,
  minScale: number,
  maxScale: number,
): View => {
  const scale = Math.min(Math.max(view.scale * factor, minScale), maxScale);
  const applied = scale / view.scale;
  return {
    scale,
    tx: sx - (sx - view.tx) * applied,
    ty: sy - (sy - view.ty) * applied,
  };
};

export const panBy = (view: View, dx: number, dy: number): View => ({
  ...view,
  tx: view.tx + dx,
  ty: view.ty + dy,
});

const hexToRgb = (hex: string): [number, number, number] => {
  const value = Number.parseInt(hex.replace('#', ''), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
};

/** 256 RGB entries of the heat scale (index = heat * 255). */
export const heatColorTable = (): Uint8ClampedArray => {
  const table = new Uint8ClampedArray(256 * 3);
  const stops = HEAT_STOPS.map(([at, hex]) => [at, ...hexToRgb(hex)] as const);
  for (let index = 0; index < 256; index += 1) {
    const heat = index / 255;
    let upper = stops.findIndex(([at]) => at >= heat);
    if (upper <= 0) {
      upper = Math.max(upper, 1);
    }
    const [fromAt, fr, fg, fb] = stops[upper - 1];
    const [toAt, tr, tg, tb] = stops[upper];
    const t = toAt === fromAt ? 0 : (heat - fromAt) / (toAt - fromAt);
    table[index * 3] = fr + (tr - fr) * t;
    table[index * 3 + 1] = fg + (tg - fg) * t;
    table[index * 3 + 2] = fb + (tb - fb) * t;
  }
  return table;
};

/** CSS colour of `heat` (0..1, clamped) from a heatColorTable. */
export const heatColorAt = (table: Uint8ClampedArray, heat: number): string => {
  const index = Math.round(Math.min(Math.max(Number.isFinite(heat) ? heat : 0, 0), 1) * 255) * 3;
  return `rgb(${table[index]}, ${table[index + 1]}, ${table[index + 2]})`;
};

/** RGBA pixels of the heat grid (grid[gy][gx], gy upwards) as an image whose
 * first row is the top - i.e. the highest gy. `alpha` (same shape, 0..1)
 * makes cells transparent, e.g. a field heatmap away from its sensors. */
export const heatPixels = (
  grid: ArrayLike<number>[],
  table: Uint8ClampedArray,
  alpha?: ArrayLike<number>[],
): Uint8ClampedArray => {
  const rows = grid.length;
  const columns = rows ? grid[0].length : 0;
  const pixels = new Uint8ClampedArray(rows * columns * 4);
  for (let gy = 0; gy < rows; gy += 1) {
    const row = grid[gy];
    const offset = (rows - 1 - gy) * columns * 4;
    for (let gx = 0; gx < columns; gx += 1) {
      const heat = Math.min(Math.max(Number(row[gx]) || 0, 0), 1);
      const color = Math.round(heat * 255) * 3;
      const pixel = offset + gx * 4;
      pixels[pixel] = table[color];
      pixels[pixel + 1] = table[color + 1];
      pixels[pixel + 2] = table[color + 2];
      pixels[pixel + 3] = alpha
        ? Math.round(Math.min(Math.max(Number(alpha[gy][gx]) || 0, 0), 1) * 255)
        : 255;
    }
  }
  return pixels;
};

/** World rectangle covered by the heat grid whose cells are centred on the
 * plot coordinates xAxis/yAxis (both ascending). */
export const heatRect = (xAxis: number[], yAxis: number[], world: WorldSize): WorldRect => {
  const halfX = xAxis.length > 1 ? (xAxis[1] - xAxis[0]) / 2 : 0;
  const halfY = yAxis.length > 1 ? (yAxis[1] - yAxis[0]) / 2 : 0;
  const [left, top] = plotToWorld(xAxis[0] - halfX, yAxis[yAxis.length - 1] + halfY, world);
  const [right, bottom] = plotToWorld(xAxis[xAxis.length - 1] + halfX, yAxis[0] - halfY, world);
  return { left, top, right, bottom };
};

/** Heat of the grid cell under a world point, null outside the grid. */
export const heatAt = (
  grid: ArrayLike<number>[],
  xAxis: number[],
  yAxis: number[],
  wx: number,
  wy: number,
  world: WorldSize,
): number | null => {
  if (xAxis.length < 2 || yAxis.length < 2) {
    return null;
  }
  const [px, py] = worldToPlot(wx, wy, world);
  const gx = Math.round((px - xAxis[0]) / (xAxis[1] - xAxis[0]));
  const gy = Math.round((py - yAxis[0]) / (yAxis[1] - yAxis[0]));
  if (gy < 0 || gy >= grid.length || gx < 0 || gx >= grid[gy].length) {
    return null;
  }
  return Number(grid[gy][gx]);
};

/** Index of the screen point nearest to (sx, sy) within `radius`, else null. */
export const nearestPoint = (
  points: Array<[number, number]>,
  sx: number,
  sy: number,
  radius: number,
): number | null => {
  let best: number | null = null;
  let bestDistance = radius;
  points.forEach(([x, y], index) => {
    const distance = Math.hypot(x - sx, y - sy);
    if (distance <= bestDistance) {
      best = index;
      bestDistance = distance;
    }
  });
  return best;
};

export const containsPoint = (rect: WorldRect, x: number, y: number) =>
  x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
