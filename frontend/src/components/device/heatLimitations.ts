/**
 * Geometry of the heat limitations (ProgeoLageplan.heat_limitations): areas
 * of the Lageplan the heat field of SensorHeatmap2D is limited to. Stored
 * normalized to the plan image (0..1, y downwards); drawn in world
 * coordinates (image pixels, see heatmapChart.ts).
 */
import type { WorldSize } from './heatmapCanvas';
import type { HeatLimitation } from './sensorHeatmapTypes';

export type Point = [number, number];

/** The fewest points of an area (as the backend requires). */
export const MIN_AREA_POINTS = 3;

/** Twice the signed area (shoelace) - positive for clockwise on screen (y down). */
export const signedArea = (points: Point[]) =>
  points.reduce((sum, [x, y], index) => {
    const [nx, ny] = points[(index + 1) % points.length];
    return sum + (x * ny - nx * y);
  }, 0);

/** The points in one orientation, so overlapping areas add up under the
 * nonzero rule instead of cutting holes into each other. */
export const oriented = (points: Point[]): Point[] =>
  signedArea(points) < 0 ? [...points].reverse() : points;

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

/** Normalized plan position -> world coordinates. */
export const toWorldPoint = ([x, y]: Point, world: WorldSize): Point => [x * world.width, y * world.height];

/** World coordinates -> normalized plan position, kept on the plan. */
export const toPlanPoint = ([wx, wy]: Point, world: WorldSize): Point => [
  clamp01(wx / world.width),
  clamp01(wy / world.height),
];

/** The clip polygons of a plan's areas, in world coordinates (Scene.limits). */
export const limitPolygons = (areas: HeatLimitation[] | null | undefined, world: WorldSize) =>
  (areas ?? [])
    .filter((area) => Array.isArray(area.points) && area.points.length >= MIN_AREA_POINTS)
    .map((area) => oriented(area.points.map((point) => toWorldPoint(point, world))));

/** The middle of an area's points (where its name is drawn). */
export const centroid = (points: Point[]): Point => [
  points.reduce((sum, [x]) => sum + x, 0) / points.length,
  points.reduce((sum, [, y]) => sum + y, 0) / points.length,
];

/** Index of the edge (i -> i + 1) closest to `point`, where a new point is
 * inserted after i - and its distance. */
export const nearestEdge = (points: Point[], [px, py]: Point) => {
  let best = { index: -1, distance: Number.POSITIVE_INFINITY };
  points.forEach(([ax, ay], index) => {
    const [bx, by] = points[(index + 1) % points.length];
    const dx = bx - ax;
    const dy = by - ay;
    const length = dx * dx + dy * dy;
    const t = length > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length)) : 0;
    const distance = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    if (distance < best.distance) {
      best = { index, distance };
    }
  });
  return best;
};
