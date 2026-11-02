import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import FrameSlider, { frameAt } from '../components/device/FrameSlider';
import LageplanZoneOverlay from '../components/device/LageplanZoneOverlay';
import type { SensorHeatmapResponse } from '../components/device/sensorHeatmapTypes';
import { planViewsOf, sensorLinesOf, viewPointsOf, zonePointsOf } from './locationStatusData';

type LocationDmPlanProps = {
  /** The heatmap response of the period (frames, plans, sensor points). */
  heatmap: SensorHeatmapResponse | null;
  /** Time (epoch ms) of the shown frame; null: the newest. */
  time: number | null;
  onTimeChange: (ms: number) => void;
  /** A click on a sensor's band line, with its pos (sensor_order). */
  onSensorClick?: (pos: number) => void;
  height?: number;
};

/**
 * smartex® dm in the Analyse tab: no heat field - the sensors' band lines on
 * the plan, coloured by their value at the slider's frame, with a tooltip
 * per sensor (LageplanZoneOverlay, as on the Status tab).
 */
const LocationDmPlan = ({ heatmap, time, onTimeChange, onSensorClick, height = 480 }: LocationDmPlanProps) => {
  const { t } = useTranslation();
  const planViews = useMemo(() => planViewsOf(heatmap), [heatmap]);
  const shownPlan = planViews[0] ?? null;
  const points = useMemo(
    () => viewPointsOf(heatmap?.sensor_points ?? [], planViews, shownPlan),
    [heatmap, planViews, shownPlan],
  );
  const lines = useMemo(
    () => sensorLinesOf(points, (row) => t('status_line_label', { line: row + 1 })),
    [points, t],
  );
  const timestamps = useMemo(() => heatmap?.timestamps ?? [], [heatmap]);
  const frameIndex = timestamps.length
    ? time == null
      ? timestamps.length - 1
      : frameAt(timestamps, time)
    : null;
  const zonePoints = useMemo(
    () =>
      zonePointsOf({
        points,
        lines,
        heatmap,
        frameIndex,
        threshold: heatmap?.location?.alarm_threshold ?? null,
      }),
    [frameIndex, heatmap, lines, points],
  );

  if (!shownPlan) {
    return <div style={{ color: '#8B8383', fontSize: 13 }}>{t('status_no_lageplan')}</div>;
  }
  return (
    <>
      {frameIndex != null && (
        <div className="px-2 py-2">
          <FrameSlider
            id="analyse-dm-frame"
            timestamps={timestamps}
            index={frameIndex}
            onChange={(index) => onTimeChange(timestamps[index] * 1000)}
            playKey={false}
          />
        </div>
      )}
      <LageplanZoneOverlay
        imageUrl={shownPlan.url ?? null}
        points={zonePoints}
        height={height}
        mode="lines"
        alignment={shownPlan}
        onPointClick={onSensorClick}
      />
    </>
  );
};

export default LocationDmPlan;
