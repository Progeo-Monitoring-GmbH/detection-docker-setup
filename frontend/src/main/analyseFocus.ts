/**
 * /analyse: the one *focused* sensor among the active ones. Active are the
 * sensors the measurements' second plot follows (a lila ring on the plan);
 * focused is the one picked last - clicked on the plan, or added alone in
 * the charts - drawn with a white ring. The focus is a pair (index from 0)
 * of one device, like the selection; it only shows while that pair is still
 * active on the shown device.
 */

export type SensorFocus = { device: number | null; pair: number };

/** The one sensor `next` adds to `previous`; null when none or several are added. */
export const addedSensor = (
  previous: readonly number[],
  next: readonly number[],
): number | null => {
  const added = next.filter((sensor) => !previous.includes(sensor));
  return added.length === 1 ? added[0] : null;
};

type FocusPoint = { pos: number; device?: number | null; pair?: number | null };

/**
 * The plan position (sensor_order) of the focused sensor, or null: none
 * focused, it is no longer active, it belongs to another device than the
 * shown one, or it has no point on the plan.
 */
export const focusedPositionOf = (
  points: readonly FocusPoint[],
  focus: SensorFocus | null,
  active: readonly number[],
  shownDevice: number | null,
): number | null => {
  if (!focus || !active.includes(focus.pair)) {
    return null;
  }
  if (
    focus.device != null &&
    shownDevice != null &&
    focus.device !== shownDevice
  ) {
    return null;
  }
  const point = points.find(
    (candidate) =>
      (candidate.device == null || candidate.device === shownDevice) &&
      (candidate.pair ?? candidate.pos) - 1 === focus.pair,
  );
  return point?.pos ?? null;
};
