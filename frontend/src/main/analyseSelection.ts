/**
 * /analyse: the plan's sensors and the measurements' second plot. The plot
 * follows pairs (index from 0) of the shown device; a plan point names its
 * device and its pair (1-based) - a location's sensors can be split over
 * devices, each counting its pairs from 1. Without a pair the plan position
 * (sensor_order) is the pair.
 */

export type SelectionPoint = {
  pos: number;
  device?: number | null;
  pair?: number | null;
  threshold?: number | null;
};

/** The pair index (from 0) of a plan point. */
const pairOf = (point: Pick<SelectionPoint, 'pos' | 'pair'>) =>
  (point.pair ?? point.pos) - 1;

/** A point without a device belongs to every one. */
const ofDevice = (
  point: Pick<SelectionPoint, 'device'>,
  shownDevice: number | null,
) => point.device == null || point.device === shownDevice;

/** The plan positions of the selected pairs of the shown device. */
export const selectedPositionsOf = (
  points: readonly SelectionPoint[],
  sensors: readonly number[],
  shownDevice: number | null,
): number[] =>
  points.flatMap((point) =>
    ofDevice(point, shownDevice) && sensors.includes(pairOf(point))
      ? [point.pos]
      : [],
  );

/** The own alarm thresholds of the shown device's sensors, by pair index. */
export const sensorThresholdsOf = (
  points: readonly SelectionPoint[],
  shownDevice: number | null,
): Map<number, number> =>
  new Map(
    points.flatMap((point) =>
      ofDevice(point, shownDevice) && point.threshold != null
        ? [[pairOf(point), point.threshold] as const]
        : [],
    ),
  );

/** `selected` with `pair` - sorted; unchanged when it is in already. */
export const withSensor = (selected: number[], pair: number): number[] =>
  selected.includes(pair)
    ? selected
    : [...selected, pair].sort((a, b) => a - b);

/** What a plan pick selects: these pairs, of `device` - null: the shown one. */
type PlanPick = { device: number | null; pairs: number[] };

/**
 * An area dragged on the plan: its sensors of the shown device, else those
 * of the first other device of the location (shown then); null: none.
 */
export const planAreaPick = (
  points: readonly SelectionPoint[],
  positions: readonly number[],
  shownDevice: number | null,
  deviceIds: readonly number[],
): PlanPick | null => {
  const picked = positions.map((pos) => {
    const point = points.find((candidate) => candidate.pos === pos);
    return { device: point?.device ?? null, pair: (point?.pair ?? pos) - 1 };
  });
  const pairsOf = (entries: typeof picked) =>
    [...new Set(entries.map((entry) => entry.pair))].sort((a, b) => a - b);
  const ofShown = picked.filter((entry) => ofDevice(entry, shownDevice));
  if (ofShown.length) {
    return { device: null, pairs: pairsOf(ofShown) };
  }
  const other = picked.find(
    (entry) => entry.device != null && deviceIds.includes(entry.device),
  );
  if (other?.device == null) {
    return null;
  }
  return {
    device: other.device,
    pairs: pairsOf(picked.filter((entry) => entry.device === other.device)),
  };
};

/**
 * A sensor clicked on the plan: its pair, and its device when that is
 * another device of the location (shown then); else `device` is null.
 */
export const planSensorPick = (
  points: readonly SelectionPoint[],
  pos: number,
  shownDevice: number | null,
  deviceIds: readonly number[],
): { device: number | null; pair: number } => {
  const point = points.find((candidate) => candidate.pos === pos);
  const pair = (point?.pair ?? pos) - 1;
  const device = point?.device ?? null;
  const other =
    device != null && device !== shownDevice && deviceIds.includes(device);
  return { device: other ? device : null, pair };
};
