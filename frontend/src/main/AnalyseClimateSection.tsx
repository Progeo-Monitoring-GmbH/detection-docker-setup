import { useState } from 'react';
import LocationClimateHeatmap from './LocationClimateHeatmap';
import LocationClimatePanels from './LocationClimatePanels';
import type { TimeRange } from './timeRanges';

type AnalyseClimateSectionProps = {
  locationId: number;
  range: TimeRange;
  /** Battery charts are device maintenance - staff (and superusers) only. */
  showBattery: boolean;
  /** The page's frame slider (epoch ms; null: the newest frame). */
  time: number | null;
  onTimeChange: (time: number) => void;
  /** The time of the slider's frame - a line on every chart. */
  frameTime: number | null;
  onHeatmapFrames: (timestamps: number[]) => void;
  onChartFrames: (timestamps: number[]) => void;
  /** The climate heatmap of the placed sensors - not in the Klima tab of a
   * leak location (its climate sensors aren't on the plan yet). */
  withHeatmap?: boolean;
  /** The charts' data arrived (also refused / failed) - see LocationClimatePanels. */
  onReady?: () => void;
};

/**
 * smartex io objects on the Analyse page: a humidity/temperature heatmap of
 * the placed sensors and their charts (the Klima tab of a leak location:
 * the charts only). The device hovered on the heatmap or in a chart is
 * highlighted in both.
 */
const AnalyseClimateSection = ({
  locationId,
  range,
  showBattery,
  time,
  onTimeChange,
  frameTime,
  onHeatmapFrames,
  onChartFrames,
  withHeatmap = true,
  onReady,
}: AnalyseClimateSectionProps) => {
  const [hoveredDeviceId, setHoveredDeviceId] = useState<number | null>(null);
  return (
    <>
      {withHeatmap && (
        <LocationClimateHeatmap
          locationId={locationId}
          range={range}
          hoveredDeviceId={hoveredDeviceId}
          onHoverDevice={setHoveredDeviceId}
          time={time}
          onTimeChange={onTimeChange}
          onFramesChange={onHeatmapFrames}
        />
      )}
      <LocationClimatePanels
        testId="analyse-climate-panels"
        locationId={locationId}
        range={range}
        showBattery={showBattery}
        hoveredDeviceId={hoveredDeviceId}
        onHoverDevice={setHoveredDeviceId}
        frameTime={frameTime}
        onFramesChange={onChartFrames}
        onReady={onReady}
      />
    </>
  );
};

export default AnalyseClimateSection;
