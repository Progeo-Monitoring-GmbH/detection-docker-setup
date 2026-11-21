import { useMemo } from 'react';
import type { SensorHeatmapResponse } from '../components/device/sensorHeatmapTypes';
import type { MeasurementCompareRow } from '../components/device/MeasurementSamplesCompareChart.tsx';
import { smoothHeatmap, smoothMeasurements } from './analyseSmoothing';
import { cleanRows, type NoiseMask } from './noiseProfiles';

/**
 * What the heatmap and the charts show: the loads - the measurements
 * cleaned first (staff: by `displayMask`) - averaged over `meanWindow`
 * neighbouring measurements. While another plan's heatmap loads, the shown
 * one stays (busy: `switchingPlan`) until it is there.
 */
const useAnalyseShown = ({
  heatmap,
  heatmapLoading,
  planId,
  measurements,
  historyRows,
  displayMask,
  meanWindow,
}: {
  heatmap: SensorHeatmapResponse | null;
  heatmapLoading: boolean;
  planId: number | null;
  measurements: MeasurementCompareRow[];
  /** Staff: the sensor history (null: not loaded). */
  historyRows: MeasurementCompareRow[] | null;
  displayMask: NoiseMask | null;
  meanWindow: number;
}) => {
  const shownHeatmap = useMemo(
    () => smoothHeatmap(heatmap, meanWindow),
    [heatmap, meanWindow],
  );
  const shownMeasurements = useMemo(
    () => smoothMeasurements(cleanRows(measurements, displayMask), meanWindow),
    [measurements, displayMask, meanWindow],
  );
  const shownSensorHistory = useMemo(
    () =>
      historyRows
        ? smoothMeasurements(cleanRows(historyRows, displayMask), meanWindow)
        : null,
    [historyRows, displayMask, meanWindow],
  );
  return {
    shownHeatmap,
    switchingPlan:
      heatmapLoading &&
      shownHeatmap != null &&
      (shownHeatmap.lageplan ?? null) !== planId,
    shownMeasurements,
    shownSensorHistory,
  };
};

export default useAnalyseShown;
