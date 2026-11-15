/**
 * Disabled sensors (ProgeoMeasurePoint.disabled, switched off in the
 * threshold mixer): they never trigger an alarm (backend:
 * progeo/helper/alarm_thresholds.py) and every view draws them in this gray
 * instead of their value's colour - the bars, the heatmaps, the plan, the
 * tables.
 */

/** Fill of a disabled sensor's bar, cell or marker. */
export const DISABLED_SENSOR_FILL = '#c9c8c2';
/** Its outline / text where the fill is too light. */
export const DISABLED_SENSOR_STROKE = '#8e8d87';

type PointLike = {
  sensor_order?: number | null;
  pos?: number | null;
  disabled?: boolean | null;
};

/** The sensor orders (sensor_order, or pos of the heatmap's points) that are disabled. */
export const disabledOrdersOf = (points: ReadonlyArray<PointLike> | null | undefined): Set<number> => {
  const orders = new Set<number>();
  (points ?? []).forEach((point) => {
    const order = point.sensor_order ?? point.pos;
    if (point.disabled && order != null) {
      orders.add(order);
    }
  });
  return orders;
};
