import type { SensorHeatmapResponse } from '../components/device/sensorHeatmapTypes';
import type { ThresholdTrendSeries } from '../components/device/ThresholdTrendChart';
import { percentChange } from '../components/device/SensorChangesPanel';
import { finiteValue } from './locationStatusData';

/** Sensors the Zeitreihe plots until the user picks others. */
export const ZEITREIHE_DEFAULT_SENSORS = 5;
/** "Active": max - min spans at least this share of the threshold. */
export const ACTIVE_RANGE = 0.2;
/** "Silent": max - min stays below this share of the threshold. */
export const SILENT_RANGE = 0.05;

/** One sensor of the Zeitreihe with what the three tables show about it. */
export type ZeitreiheSensor = {
  id: string;
  sensorId: number;
  label: string;
  threshold: number | null;
  points: ThresholdTrendSeries['points'];
  min: number;
  max: number;
  /** max - min (measured units). */
  range: number;
  /** max and range as a multiple of the threshold (of 1 without one). */
  peakRatio: number;
  rangeRatio: number;
  /** First to last value in the period, in percent of the first (as on
   * Analyse, "Größte Änderungen"); null when the first was 0. */
  trend: number | null;
  /** At least one value above the threshold. */
  triggered: boolean;
  active: boolean;
  silent: boolean;
};

/**
 * Every sensor with values in the Zeitreihe (in sensor order), classified for
 * the three tables - a sensor can be in several: triggered (a value above
 * its threshold), active (large span) and silent (hardly any change).
 */
export const zeitreiheSensorsOf = (
  zeitreihe: Pick<SensorHeatmapResponse, 'timestamps' | 'data'> | null,
  labelOf: (sensorId: number) => string,
  thresholdOf: (sensorId: number) => number | null,
): ZeitreiheSensor[] => {
  if (!zeitreihe) {
    return [];
  }
  return Object.keys(zeitreihe.data)
    .map(Number)
    .sort((a, b) => a - b)
    .flatMap((sensorId) => {
      const raw = zeitreihe.data[sensorId] || [];
      const values = raw.flatMap((value) => {
        const finite = finiteValue(value);
        return finite == null ? [] : [finite];
      });
      if (!values.length) {
        return [];
      }
      const threshold = thresholdOf(sensorId);
      const hasThreshold = threshold != null && threshold > 0;
      const scale = hasThreshold ? threshold : 1;
      const min = Math.min(...values);
      const max = Math.max(...values);
      const range = max - min;
      return [
        {
          id: `sensor-${sensorId}`,
          sensorId,
          label: labelOf(sensorId),
          threshold,
          points: raw.map((value, index) => {
            const timestamp = zeitreihe.timestamps[index];
            return {
              id: `${sensorId}:${index}`,
              triggered_at: timestamp != null ? new Date(timestamp * 1000).toISOString() : null,
              value,
            };
          }),
          min,
          max,
          range,
          peakRatio: max / scale,
          rangeRatio: range / scale,
          trend: percentChange(values[0], values[values.length - 1]),
          triggered: hasThreshold && max > threshold,
          active: range / scale >= ACTIVE_RANGE,
          silent: range / scale < SILENT_RANGE,
        },
      ];
    });
};

/** Highest peak (relative to the threshold) first. */
export const byPeak = (a: ZeitreiheSensor, b: ZeitreiheSensor) => b.peakRatio - a.peakRatio || a.sensorId - b.sensorId;
/** Largest span (relative to the threshold) first. */
export const byRange = (a: ZeitreiheSensor, b: ZeitreiheSensor) =>
  b.rangeRatio - a.rangeRatio || a.sensorId - b.sensorId;

/**
 * The sensors plotted before the user picks: the triggered ones (highest
 * peak first), then the most active - ZEITREIHE_DEFAULT_SENSORS at most.
 * Silent sensors only when nothing else moves.
 */
export const defaultZeitreiheIds = (sensors: ZeitreiheSensor[]): string[] => {
  const ordered = [
    ...sensors.filter((sensor) => sensor.triggered).sort(byPeak),
    ...sensors.filter((sensor) => !sensor.triggered && !sensor.silent).sort(byRange),
    ...sensors.filter((sensor) => !sensor.triggered && sensor.silent).sort(byRange),
  ];
  return ordered.slice(0, ZEITREIHE_DEFAULT_SENSORS).map((sensor) => sensor.id);
};

/** `ids` with `id` removed, or appended (keeps the others' order - and colours). */
export const toggledId = (ids: string[], id: string) =>
  ids.includes(id) ? ids.filter((entry) => entry !== id) : [...ids, id];
