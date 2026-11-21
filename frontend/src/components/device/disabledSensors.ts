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
