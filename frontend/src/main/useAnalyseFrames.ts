import { useMemo, useState } from 'react';
import type { MeasurementCompareRow } from '../components/device/MeasurementSamplesCompareChart.tsx';
import type { SensorHeatmapResponse } from '../components/device/sensorHeatmapTypes';
import { frameAt } from '../components/device/FrameSlider';
import { chartFramesOf, frameSecondsOf } from './analysePageHelp';

/**
 * The page's one frame slider: its time (epoch ms; null: the newest
 * measurement) - the heatmap and the measurements show the frame holding
 * it. Its frames are the heatmap's - the measurements (sampled a little
 * differently) show the one nearest to it; without a heatmap theirs.
 * smartex io: the climate heatmap's, without one the climate charts' readings
 * (reported by them).
 */
const useAnalyseFrames = ({
  isSmartexIo,
  heatmap,
  measurements,
}: {
  isSmartexIo: boolean;
  heatmap: SensorHeatmapResponse | null;
  measurements: MeasurementCompareRow[];
}) => {
  const [frameTime, setFrameTime] = useState<number | null>(null);
  const heatmapFrames = useMemo(
    () => [...(heatmap?.timestamps ?? [])].sort((a, b) => a - b),
    [heatmap],
  );
  const chartFrames = useMemo(
    () => chartFramesOf(measurements),
    [measurements],
  );
  const [climateHeatmapFrames, setClimateHeatmapFrames] = useState<number[]>(
    [],
  );
  const [climateChartFrames, setClimateChartFrames] = useState<number[]>([]);
  const frameSeconds = isSmartexIo
    ? frameSecondsOf(climateHeatmapFrames, climateChartFrames)
    : frameSecondsOf(heatmapFrames, chartFrames);
  const frameIndex =
    frameTime == null
      ? frameSeconds.length - 1
      : frameAt(frameSeconds, frameTime);
  return {
    frameTime,
    setFrameTime,
    frameSeconds,
    frameIndex,
    /** The time (epoch ms) of the frame shown; null: no frames. */
    frameMs: frameSeconds.length ? frameSeconds[frameIndex] * 1000 : null,
    setClimateHeatmapFrames,
    setClimateChartFrames,
  };
};

export default useAnalyseFrames;
