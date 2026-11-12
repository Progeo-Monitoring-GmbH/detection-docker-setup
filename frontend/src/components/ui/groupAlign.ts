/**
 * Group alignment of the Lageplan wizard (L + drag, ImageCanvasStage): some
 * measure points - e.g. ones moved over from another plan - are fitted onto
 * their place by themselves, the plan's alignment and the other points stay.
 *
 * Works in fractions of the plan image (0..1, y down): the pins say where
 * the grabbed points are now and where they belong; per axis the fit is
 * target = intercept + slope * source. One pin moves the group, two or more
 * also scale it (an axis the pins don't spread along takes the other one's
 * scale). The moved points get new normalized positions - see toNormalized.
 */
import { placeWith, type FittedAlignment } from './alignmentFit';

export type GroupPin = { source: [number, number]; target: [number, number] };

type Axis = { slope: number; intercept: number };
export type GroupTransform = { x: Axis; y: Axis };
export type GroupFit = { transform: GroupTransform } | { problem: string };

type Alignment = Omit<FittedAlignment, 'errorPx'>;

/** Sources closer than this (share of the image) count as one place. */
const MIN_SPREAD = 0.002;
/** Scales a group may get - beyond them a pin is surely misplaced. */
const MIN_SLOPE = 0.05;
const MAX_SLOPE = 20;

const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

/** Least-squares slope of one axis, null when the sources don't spread. */
const slopeOf = (pairs: Array<[number, number]>) => {
  const sourceMean = mean(pairs.map(([source]) => source));
  const targetMean = mean(pairs.map(([, target]) => target));
  const spread = pairs.reduce((sum, [source]) => sum + (source - sourceMean) ** 2, 0);
  if (Math.sqrt(spread / pairs.length) < MIN_SPREAD) {
    return null;
  }
  return pairs.reduce((sum, [source, target]) => sum + (source - sourceMean) * (target - targetMean), 0) / spread;
};

export const fitGroup = (pins: GroupPin[]): GroupFit => {
  if (!pins.length) {
    return { problem: 'Drag one of the selected points onto its place.' };
  }
  const xPairs = pins.map(({ source, target }): [number, number] => [source[0], target[0]]);
  const yPairs = pins.map(({ source, target }): [number, number] => [source[1], target[1]]);
  const slopeX = pins.length > 1 ? slopeOf(xPairs) : null;
  const slopeY = pins.length > 1 ? slopeOf(yPairs) : null;
  // One pin (or pins in one place): moved only; pins in a row: the same scale both ways.
  const x = slopeX ?? slopeY ?? 1;
  const y = slopeY ?? slopeX ?? 1;
  if ([x, y].some((slope) => slope < MIN_SLOPE || slope > MAX_SLOPE)) {
    return {
      problem:
        x < 0 || y < 0
          ? 'These pins would mirror the points - check that each went to its own place.'
          : 'These pins would shrink or stretch the points far too much - check the dragged points.',
    };
  }
  const axis = (pairs: Array<[number, number]>, slope: number): Axis => ({
    slope,
    intercept: mean(pairs.map(([, target]) => target)) - slope * mean(pairs.map(([source]) => source)),
  });
  return { transform: { x: axis(xPairs, x), y: axis(yPairs, y) } };
};

export const applyGroup = ([fx, fy]: [number, number], { x, y }: GroupTransform): [number, number] => [
  x.intercept + x.slope * fx,
  y.intercept + y.slope * fy,
];

/** Where a normalized point lies on the plan (fraction of the image). */
export const toFraction = (
  point: [number, number],
  alignment: Alignment,
  width: number,
  height: number,
  base: number,
): [number, number] => placeWith(point, alignment, width, height, base);

/** The normalized point the alignment puts at a fraction of the image - placeWith inverted. */
export const toNormalized = (
  [fx, fy]: [number, number],
  alignment: Alignment,
  width: number,
  height: number,
  base: number,
): [number, number] => {
  const nx = (fx - alignment.offsetX / (width * base)) / alignment.scaleX;
  const drawn = (fy - alignment.offsetY / (height * base)) / alignment.scaleY;
  return [nx, alignment.flipY ? 1 - drawn : drawn];
};
