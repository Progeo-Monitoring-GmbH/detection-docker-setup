import { describe, expect, it } from 'vitest';
import {
  containsPoint,
  fitView,
  heatAt,
  heatColorTable,
  heatPixels,
  heatRect,
  nearestPoint,
  panBy,
  plotToWorld,
  toScreen,
  toWorld,
  worldToPlot,
  zoomAt,
} from './heatmapCanvas';

const world = { width: 1600, height: 1200 };

describe('coordinates', () => {
  it('maps plot space (y up) onto image pixels (y down) and back', () => {
    expect(plotToWorld(0, 1, world)).toEqual([0, 0]);
    expect(plotToWorld(0.5, 0.25, world)).toEqual([800, 900]);
    expect(worldToPlot(800, 900, world)).toEqual([0.5, 0.25]);
  });

  it('converts between world and screen with the view', () => {
    const view = { scale: 2, tx: 10, ty: -20 };
    expect(toScreen(view, 100, 50)).toEqual([210, 80]);
    expect(toWorld(view, 210, 80)).toEqual([100, 50]);
  });
});

describe('fitView', () => {
  it('shows the bounds as large as possible and centred', () => {
    const view = fitView({ left: 100, top: 200, right: 500, bottom: 400 }, 800, 400);
    // 400 x 200 world units into 800 x 400 pixels: scale 2, exactly filling.
    expect(view.scale).toBe(2);
    expect(toScreen(view, 100, 200)).toEqual([0, 0]);
    expect(toScreen(view, 500, 400)).toEqual([800, 400]);
  });

  it('keeps the reserved space on the right free', () => {
    const view = fitView({ left: 0, top: 0, right: 100, bottom: 100 }, 260, 400, 60);
    const [right] = toScreen(view, 100, 50);
    expect(right).toBeLessThanOrEqual(200);
  });
});

describe('zoom and pan', () => {
  it('keeps the world point under the cursor in place', () => {
    const view = { scale: 1.5, tx: 30, ty: 40 };
    const before = toWorld(view, 200, 150);
    const zoomed = zoomAt(view, 2, 200, 150, 0.1, 100);
    expect(zoomed.scale).toBe(3);
    const after = toWorld(zoomed, 200, 150);
    expect(after[0]).toBeCloseTo(before[0]);
    expect(after[1]).toBeCloseTo(before[1]);
  });

  it('clamps the scale', () => {
    const view = { scale: 1, tx: 0, ty: 0 };
    expect(zoomAt(view, 100, 0, 0, 0.5, 4).scale).toBe(4);
    expect(zoomAt(view, 0.01, 0, 0, 0.5, 4).scale).toBe(0.5);
  });

  it('moves by screen pixels', () => {
    expect(panBy({ scale: 2, tx: 1, ty: 2 }, 10, -5)).toEqual({ scale: 2, tx: 11, ty: -3 });
  });
});

describe('heat colours', () => {
  it('runs from brand blue to brand orange', () => {
    const table = heatColorTable();
    expect(Array.from(table.slice(0, 3))).toEqual([0x09, 0x4b, 0x81]);
    expect(Array.from(table.slice(255 * 3, 255 * 3 + 3))).toEqual([0xeb, 0x63, 0x3b]);
  });

  it('puts the highest grid row (top of the plan) first', () => {
    const table = heatColorTable();
    const grid = [Float64Array.from([0, 0]), Float64Array.from([1, 1])];
    const pixels = heatPixels(grid, table);
    // First pixel = grid[1][0] = heat 1 = orange, fully opaque.
    expect(Array.from(pixels.slice(0, 4))).toEqual([0xeb, 0x63, 0x3b, 255]);
    expect(Array.from(pixels.slice(8, 11))).toEqual([0x09, 0x4b, 0x81]);
  });
});

describe('heat field placement', () => {
  const axis = [0, 0.5, 1];
  const grid = [Float64Array.from([0.1, 0.2, 0.3]), Float64Array.from([0.4, 0.5, 0.6]), Float64Array.from([0.7, 0.8, 0.9])];

  it('covers the grid cells around the axis values', () => {
    expect(heatRect(axis, axis, world)).toEqual({ left: -400, top: -300, right: 2000, bottom: 1500 });
  });

  it('reads the cell under a world point', () => {
    // Plot (1, 1) = top right of the image = grid[2][2].
    expect(heatAt(grid, axis, axis, 1600, 0, world)).toBe(0.9);
    // Plot (0, 0) = bottom left = grid[0][0].
    expect(heatAt(grid, axis, axis, 0, 1200, world)).toBe(0.1);
    expect(heatAt(grid, axis, axis, 5000, 0, world)).toBeNull();
  });
});

describe('nearestPoint', () => {
  it('finds the closest point within the radius', () => {
    const points: Array<[number, number]> = [[10, 10], [30, 10], [100, 100]];
    expect(nearestPoint(points, 27, 12, 10)).toBe(1);
    expect(nearestPoint(points, 60, 60, 10)).toBeNull();
  });
});

describe('drawn area', () => {
  it('tells what lies inside a rectangle', () => {
    const plan = { left: 0, top: 0, right: 100, bottom: 50 };
    expect(containsPoint(plan, 100, 50)).toBe(true);
    expect(containsPoint(plan, 101, 20)).toBe(false);
    expect(containsPoint(plan, 50, -1)).toBe(false);
  });
});
