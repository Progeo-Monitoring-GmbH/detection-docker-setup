/**
 * Point calibration of the Lageplan wizard (hold A and drag, ImageCanvasStage):
 * from sensors dragged onto their place on the plan, the alignment that puts
 * them there - per axis a least-squares line through the pins: two far apart
 * pins fix it, more average out small misplacements.
 *
 * The alignment maps a normalized point (nx/ny) to a fraction of the plan
 * image (y downwards) as the wizard draws it:
 *     fx = offset_x / (width * base) + nx * scale_x
 *     fy = offset_y / (height * base) + (flip_y ? 1 - ny : ny) * scale_y
 * with `base` = alignmentBaseScale of the image (offsets are canvas pixels).
 */

/** A sensor point (normalized) and where it belongs (fraction of the image). */
export type AlignPin = { source: [number, number]; target: [number, number] };

export type FittedAlignment = {
  offsetX: number;
  offsetY: number;
  scaleX: number;
  scaleY: number;
  flipY: boolean;
  /** Farthest a pin lands from its target with this alignment (image pixels). */
  errorPx: number;
};

export type AlignmentFit = { alignment: FittedAlignment } | { problem: string };

/** Pins needed before the alignment is computed - two are enough when they
 * lie far apart both across and along the plan (TWO_PIN_SPREAD). */
export const ALIGN_PINS = 2;
/** Two pins: how far apart (share of the points' frame) they must lie in x and y. */
const TWO_PIN_SPREAD = 0.25;
/** Decimals of the computed scales; offsets are whole canvas pixels (stored as integers). */
const SCALE_DECIMALS = 4;
// The limits update_alignment accepts.
const MIN_SCALE = 0.1;
const MAX_SCALE = 5;
const MAX_OFFSET = 250;

const round = (value: number, decimals: number) => Number(value.toFixed(decimals));

/** Least-squares line target = intercept + slope * source; null when the
 * sources don't spread (all pins in one row/column). */
const fitAxis = (pairs: Array<[number, number]>) => {
  const count = pairs.length;
  const meanSource = pairs.reduce((sum, [source]) => sum + source, 0) / count;
  const meanTarget = pairs.reduce((sum, [, target]) => sum + target, 0) / count;
  const spread = pairs.reduce((sum, [source]) => sum + (source - meanSource) ** 2, 0);
  if (spread < 1e-10) {
    return null;
  }
  const slope =
    pairs.reduce((sum, [source, target]) => sum + (source - meanSource) * (target - meanTarget), 0) / spread;
  return { slope, intercept: meanTarget - slope * meanSource };
};

/** Least-squares slope of target = intercept + slope * source with the intercept given. */
const slopeThrough = (pairs: Array<[number, number]>, intercept: number) =>
  pairs.reduce((sum, [source, target]) => sum + source * (target - intercept), 0) /
  pairs.reduce((sum, [source]) => sum + source * source, 0);

/** Where the alignment puts a normalized point (fraction of the image). */
export const placeWith = (
  [nx, ny]: [number, number],
  alignment: Omit<FittedAlignment, 'errorPx'>,
  width: number,
  height: number,
  base: number,
): [number, number] => [
  alignment.offsetX / (width * base) + nx * alignment.scaleX,
  alignment.offsetY / (height * base) + (alignment.flipY ? 1 - ny : ny) * alignment.scaleY,
];

/**
 * The alignment putting the pins' sources onto their targets - offsets in
 * whole canvas pixels, scales to SCALE_DECIMALS, fitted again with the
 * rounded offsets so they make up for the rounding - or why there is none.
 * `width`/`height`: the plan image's size, `base`: its alignmentBaseScale.
 */
export const fitAlignment = (pins: AlignPin[], width: number, height: number, base: number): AlignmentFit => {
  if (pins.length < ALIGN_PINS) {
    return { problem: `Drag ${ALIGN_PINS - pins.length} more sensor(s) onto their place.` };
  }
  if (pins.length === 2) {
    const [first, second] = pins.map((pin) => pin.source);
    if (Math.abs(first[0] - second[0]) < TWO_PIN_SPREAD || Math.abs(first[1] - second[1]) < TWO_PIN_SPREAD) {
      return {
        problem: 'These two sensors lie too close together - pick two far apart (e.g. opposite corners) or add a third.',
      };
    }
  }
  const xPairs = pins.map(({ source, target }): [number, number] => [source[0], target[0]]);
  const x = fitAxis(xPairs);
  const y = fitAxis(pins.map(({ source, target }) => [source[1], target[1]]));
  if (!x || !y) {
    return {
      problem: 'Pick sensors that lie apart both across and along the plan - not all in one row or column.',
    };
  }
  if (x.slope <= 0) {
    return { problem: 'These pins would mirror the plan left to right - check that each sensor went to its own place.' };
  }
  // A falling y line is the vertical flip: fy = c + d*ny = (c + d) + (1 - ny) * -d.
  const flipY = y.slope < 0;
  const yPairs = pins.map(({ source, target }): [number, number] => [flipY ? 1 - source[1] : source[1], target[1]]);
  const offsetX = Math.round(x.intercept * width * base);
  const offsetY = Math.round((flipY ? y.intercept + y.slope : y.intercept) * height * base);
  const alignment = {
    offsetX,
    offsetY,
    scaleX: round(slopeThrough(xPairs, offsetX / (width * base)), SCALE_DECIMALS),
    scaleY: round(slopeThrough(yPairs, offsetY / (height * base)), SCALE_DECIMALS),
    flipY,
  };
  if (
    alignment.scaleX < MIN_SCALE || alignment.scaleX > MAX_SCALE ||
    alignment.scaleY < MIN_SCALE || alignment.scaleY > MAX_SCALE
  ) {
    return { problem: `The pins need a scale outside ${MIN_SCALE}-${MAX_SCALE} - check the dragged sensors.` };
  }
  if (Math.abs(alignment.offsetX) > MAX_OFFSET || Math.abs(alignment.offsetY) > MAX_OFFSET) {
    return { problem: 'The pins move the points too far off the plan - check the dragged sensors.' };
  }
  const errorPx = Math.max(
    ...pins.map(({ source, target }) => {
      const [fx, fy] = placeWith(source, alignment, width, height, base);
      return Math.hypot((fx - target[0]) * width, (fy - target[1]) * height);
    }),
  );
  return { alignment: { ...alignment, errorPx } };
};
