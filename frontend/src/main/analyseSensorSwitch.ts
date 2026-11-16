/**
 * /analyse: switching the selected sensors off / on (ProgeoMeasurePoint.disabled
 * via POST /v1/location/<id>/measurepoints/). The selection holds pair indexes
 * (from 0) of the shown device; the backend wants the location's sensor_order.
 */

type SwitchPoint = {
  /** sensor_order */
  pos: number;
  device?: number | null;
  /** The device's pair (from 1); null: pos counts. */
  pair?: number | null;
  disabled?: boolean | null;
};

const ofDevice = (point: SwitchPoint, device: number | null) => point.device == null || point.device === device;

const pairOf = (point: SwitchPoint) => (point.pair ?? point.pos) - 1;

/**
 * The sensor_order of `device`'s pair (index from 0): from its measure point;
 * without one, a location with a single device counts its sensors like its
 * pairs. null: not to be found (several devices, no point).
 */
export const sensorOrderOf = (
  points: readonly SwitchPoint[],
  device: number | null,
  pair: number,
  deviceCount: number,
): number | null => {
  const point = points.find((entry) => ofDevice(entry, device) && pairOf(entry) === pair);
  if (point) {
    return point.pos;
  }
  return deviceCount <= 1 ? pair + 1 : null;
};

/** Key of a switch made on the page, before the heatmap brings it. */
export const overrideKey = (location: number, device: number | null, pair: number) => `${location}:${device}:${pair}`;

/**
 * The disabled pairs (index from 0) of `device`: the points' state, the
 * switches made on the page since (`overrides`, overrideKey -> disabled) on top.
 */
export const disabledPairsOf = (
  points: readonly SwitchPoint[],
  location: number,
  device: number | null,
  overrides: Readonly<Record<string, boolean>>,
): Set<number> => {
  const disabled = new Set(points.flatMap((point) => (point.disabled && ofDevice(point, device) ? [pairOf(point)] : [])));
  const prefix = overrideKey(location, device, 0).slice(0, -1);
  Object.entries(overrides).forEach(([key, off]) => {
    if (!key.startsWith(prefix)) {
      return;
    }
    const pair = Number(key.slice(prefix.length));
    if (off) {
      disabled.add(pair);
    } else {
      disabled.delete(pair);
    }
  });
  return disabled;
};
