import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { SensorHeatmapResponse } from '../components/device/sensorHeatmapTypes';
import { formatDate } from './dateFormat';
import {
  alarmSpansOf,
  measurePointMeters,
  sensorNameOf,
  type VerdachtsstelleCluster,
} from './locationStatusData';
import type { PlanVisualization } from './projectType';
import { zeitreiheSensorsOf } from './zeitreiheSensors';

const formatSpanTime = (ms: number) => formatDate(ms, 'dayMonthTime');

/**
 * The sensors as the status page names them: the placed ProgeoMeasurePoint
 * of a sensor, if any (its name and own threshold override win over the
 * generic label/object default), its label, metres and whether it is off.
 */
export const useSensorLabels = (
  history: SensorHeatmapResponse | null,
  visualization: PlanVisualization,
) => {
  const { t } = useTranslation();
  const sensorPoints = useMemo(() => history?.sensor_points ?? [], [history]);
  const measurePointOf = useCallback(
    (sensorId: number) => sensorPoints.find((point) => point.pos === sensorId),
    [sensorPoints],
  );
  // The name the plan gives a sensor (its own, else its dm band / line);
  // "Sensor #7" only without one.
  const sensorLabel = useCallback(
    (sensorId: number) =>
      sensorNameOf(
        measurePointOf(sensorId),
        visualization === 'lines'
          ? (row) => t('status_line_label', { line: row + 1 })
          : null,
      ) ?? t('status_sensor_label', { sensor: sensorId }),
    [measurePointOf, t, visualization],
  );
  const metersOf = useCallback(
    (sensorId: number) => measurePointMeters(measurePointOf(sensorId)),
    [measurePointOf],
  );
  const disabledOf = useCallback(
    (sensorId: number) => Boolean(measurePointOf(sensorId)?.disabled),
    [measurePointOf],
  );
  return { measurePointOf, sensorLabel, metersOf, disabledOf };
};

/**
 * Zeitreihe ("Letzte 24 h" ... "Letzte 3 Jahre", see timeRanges.ts): the
 * measured value of every sensor over the range, cut out of the loaded
 * history like the heatmap's frames - classified for ZeitreihePanel.
 */
export const useZeitreiheSensors = (
  zeitreihe: Parameters<typeof zeitreiheSensorsOf>[0],
  { measurePointOf, sensorLabel, disabledOf }: ReturnType<typeof useSensorLabels>,
  threshold: number | null,
) =>
  useMemo(
    () =>
      zeitreiheSensorsOf(
        zeitreihe,
        sensorLabel,
        (sensorId) => measurePointOf(sensorId)?.threshold ?? threshold,
        disabledOf,
      ),
    [measurePointOf, sensorLabel, disabledOf, threshold, zeitreihe],
  );

/** The Verdachtsstellen' alarm periods, marked on the plan's frame slider. */
export const useAlarmSpans = (
  clusters: VerdachtsstelleCluster[],
  now: number,
  sensorLabel: (sensorId: number) => string,
) => {
  const { t } = useTranslation();
  return useMemo(
    () =>
      alarmSpansOf(clusters, now, (cluster, from, to) =>
        to == null
          ? t('status_alarm_span_active', {
              sensor: sensorLabel(cluster.sensor_id),
              from: formatSpanTime(from),
            })
          : t('status_alarm_span', {
              sensor: sensorLabel(cluster.sensor_id),
              from: formatSpanTime(from),
              to: formatSpanTime(to),
            }),
      ),
    [clusters, now, sensorLabel, t],
  );
};
