/**
 * The alarm threshold area of the measurements' plots: below it a sensor
 * raises no alarm. The first plot (SensorColumnsPlot, signed WP − EP) shows
 * ±threshold per column; the second plot (|WP − EP| of the selected sensors
 * over time) shows 0..threshold - one green band for the threshold all of
 * them share at least, plus a dashed line in a sensor's colour where its own
 * threshold lies higher.
 */

/** Green: inside it no alarm. */
export const THRESHOLD_AREA_FILL = 'rgba(44, 160, 44, 0.13)';

/** A sensor's threshold: its own, else the location's; null without one. */
export const sensorThresholdOf = (
  sensor: number,
  threshold: number | null | undefined,
  sensorThresholds: ReadonlyMap<number, number> | null | undefined,
): number | null => {
  const own = sensorThresholds?.get(sensor);
  if (own != null && own > 0) {
    return own;
  }
  return threshold != null && threshold > 0 ? threshold : null;
};

export type ThresholdArea = {
  /** Top of the green band (0..top); null: no threshold to show. */
  top: number | null;
  /** Selected sensors whose threshold lies above the band. */
  lines: { sensor: number; value: number }[];
};

/** The second plot's threshold area for the `selected` sensors (pair index). */
export const thresholdAreaOf = (
  selected: readonly number[],
  threshold: number | null | undefined,
  sensorThresholds: ReadonlyMap<number, number> | null | undefined,
): ThresholdArea => {
  if (!selected.length) {
    // No sensor yet: the location's threshold, so the plot still shows it.
    return {
      top: threshold != null && threshold > 0 ? threshold : null,
      lines: [],
    };
  }
  const thresholds = selected.flatMap((sensor) => {
    const value = sensorThresholdOf(sensor, threshold, sensorThresholds);
    return value != null ? [{ sensor, value }] : [];
  });
  if (!thresholds.length) {
    return { top: null, lines: [] };
  }
  const top = Math.min(...thresholds.map(({ value }) => value));
  return { top, lines: thresholds.filter(({ value }) => value > top) };
};
