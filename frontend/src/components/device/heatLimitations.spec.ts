import { describe, expect, it } from 'vitest';
import { centroid, limitPolygons, nearestEdge, oriented, signedArea, toPlanPoint, type Point } from './heatLimitations';

const world = { width: 200, height: 100 };
const square: Point[] = [
  [0.1, 0.1],
  [0.5, 0.1],
  [0.5, 0.5],
  [0.1, 0.5],
];

describe('heat limitations', () => {
  it('maps the normalized points onto the plan image', () => {
    expect(limitPolygons([{ id: 'a', name: '', points: square }], world)).toEqual([
      [
        [20, 10],
        [100, 10],
        [100, 50],
        [20, 50],
      ],
    ]);
  });

  it('skips areas with fewer than three points and copes without any', () => {
    expect(limitPolygons([{ id: 'a', name: '', points: square.slice(0, 2) }], world)).toEqual([]);
    expect(limitPolygons(null, world)).toEqual([]);
  });

  it('turns every area the same way, so overlapping ones add up', () => {
    const reversed = [...square].reverse();
    expect(signedArea(square)).toBeGreaterThan(0);
    expect(signedArea(reversed)).toBeLessThan(0);
    expect(signedArea(oriented(reversed))).toBeGreaterThan(0);
    expect(oriented(square)).toBe(square);
  });

  it('keeps dragged points on the plan', () => {
    expect(toPlanPoint([-20, 150], world)).toEqual([0, 1]);
    expect(toPlanPoint([50, 25], world)).toEqual([0.25, 0.25]);
  });

  it('finds the edge a new point goes into', () => {
    // Below the bottom edge (index 2: point 2 -> point 3).
    expect(nearestEdge(square, [0.3, 0.55]).index).toBe(2);
    // Left of the closing edge (point 3 -> point 0).
    expect(nearestEdge(square, [0.05, 0.3]).index).toBe(3);
  });

  it('puts the label in the middle of the points', () => {
    const [x, y] = centroid(square);
    expect(x).toBeCloseTo(0.3);
    expect(y).toBeCloseTo(0.3);
  });
});
