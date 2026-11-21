import { useCallback, useEffect, useMemo, useState } from 'react';
import { focusFrameIndex, frameAt } from './FrameSlider';
import type { SensorHeatmapResponse } from './sensorHeatmapTypes';

/** The frame picked on the own slider - for these timestamps and focus only. */
type OwnPick = { timestamps: number[]; focus: number; index: number };

/**
 * The frame SensorHeatmap2D shows (not clamped): coupled (`coupled`, the
 * page's slider) the one holding `time` - the newest while null; else the one
 * picked on the own slider for these timestamps and focusRevision, or the one
 * holding `focusTime`, else the newest.
 */
export const pickedFrameIndex = ({
  timestamps,
  coupled,
  time,
  ownPick,
  focusTime,
  focusRevision,
}: {
  timestamps: number[];
  coupled: boolean;
  time: number | null;
  ownPick: OwnPick | null;
  focusTime: number | null;
  focusRevision: number;
}) => {
  if (coupled) {
    return time == null ? timestamps.length - 1 : frameAt(timestamps, time);
  }
  if (ownPick?.timestamps === timestamps && ownPick.focus === focusRevision) {
    return ownPick.index;
  }
  return focusFrameIndex(timestamps, focusTime) ?? timestamps.length - 1;
};

/** A frame index within the timestamps there are (0 without any). */
export const clampFrameIndex = (index: number, count: number) =>
  Math.max(0, Math.min(index, count - 1));

/**
 * The frames of a heatmap response and the one shown (see pickedFrameIndex):
 * new data (another period or step) starts at the newest frame again (or the
 * one holding `focusTime`), and so does a new focusRevision. Picking a frame
 * keeps it here, or - coupled with `onTimeChange` - reports its time (ms).
 * `onTimestampChange` hears of every frame shown.
 */
export const useHeatmapFrames = ({
  response,
  time,
  onTimeChange,
  focusTime,
  focusRevision,
  onTimestampChange,
}: {
  response: SensorHeatmapResponse | null | undefined;
  time: number | null;
  onTimeChange: ((ms: number) => void) | undefined;
  focusTime: number | null;
  focusRevision: number;
  onTimestampChange: ((index: number) => void) | undefined;
}) => {
  const timestamps = useMemo(
    () => (Array.isArray(response?.timestamps) ? response.timestamps : []),
    [response],
  );
  const [ownPick, setOwnPick] = useState<OwnPick | null>(null);
  const frameIndex = clampFrameIndex(
    pickedFrameIndex({
      timestamps,
      coupled: Boolean(onTimeChange),
      time,
      ownPick,
      focusTime,
      focusRevision,
    }),
    timestamps.length,
  );
  const setFrameIndex = useCallback(
    (index: number) => {
      if (!onTimeChange) {
        setOwnPick({ timestamps, focus: focusRevision, index });
      } else if (index >= 0 && index < timestamps.length) {
        onTimeChange(timestamps[index] * 1000);
      }
    },
    [focusRevision, onTimeChange, timestamps],
  );
  useEffect(() => {
    onTimestampChange?.(frameIndex);
  }, [onTimestampChange, frameIndex]);
  return { timestamps, frameIndex, setFrameIndex };
};
