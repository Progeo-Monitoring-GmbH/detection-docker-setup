import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import FrameSlider, { type AlarmSpan } from '../components/device/FrameSlider';
import LageplanZoneOverlay from '../components/device/LageplanZoneOverlay';
import SensorHeatmap2D from '../components/device/SensorHeatmap2D';
import SensorListTable from '../components/device/SensorListTable';
import type { SensorHeatmapResponse } from '../components/device/sensorHeatmapTypes';
import PanelCard from '../components/ui/kit/PanelCard';
import SegmentedControl from '../components/ui/kit/SegmentedControl';
import {
  planViewsOf,
  sensorLinesOf,
  sensorRowsOf,
  sensorStatsOf,
  viewHeatmapOf,
  viewPointsOf,
  zonePointsOf,
} from './locationStatusData';
import type { PlanVisualization } from './projectType';

type LocationPlanPanelProps = {
  /** The frames of the selected range (with the location's plans and points). */
  heatmap: SensorHeatmapResponse | null;
  visualization: PlanVisualization;
  /** List every sensor (with its name) below the plan. */
  withSensorTable: boolean;
  /** The object's default alarm threshold. */
  threshold: number | null;
  /** No permission to see the location's measurements. */
  denied: boolean;
  alarmSpans: AlarmSpan[];
};

const PlanHint = ({ children }: { children: ReactNode }) => (
  <div style={{ color: '#8B8383', fontSize: 13 }}>{children}</div>
);

/**
 * "Dachansicht": the shown view (Lageplan) of the location with its sensors -
 * per product (see projectType.ts) a heatmap, or lines, segments or points
 * on the plan - and the sensor table, which follows the shown frame.
 */
const LocationPlanPanel = ({
  heatmap,
  visualization,
  withSensorTable,
  threshold,
  denied,
  alarmSpans,
}: LocationPlanPanelProps) => {
  const { t } = useTranslation();
  const [selectedPlanId, setSelectedPlanId] = useState<number | null>(null);
  // The frame the plan shows (its slider). The heatmap reports its own; the
  // overlays show the newest whenever the frames change (`picked.heatmap`).
  const [picked, setPicked] = useState<{
    heatmap: SensorHeatmapResponse | null;
    index: number | null;
  }>({ heatmap: null, index: null });
  const frameTotal = heatmap?.timestamps.length ?? 0;
  const newestFrame = frameTotal > 0 ? frameTotal - 1 : null;
  const frameIndex =
    visualization === 'heatmap' || picked.heatmap === heatmap ? picked.index : newestFrame;
  // Stable per heatmap: SensorHeatmap2D reports its frame from an effect on it.
  const setFrameIndex = useCallback(
    (index: number | null) =>
      setPicked((prev) =>
        prev.heatmap === heatmap && prev.index === index ? prev : { heatmap, index },
      ),
    [heatmap],
  );

  const planViews = useMemo(() => planViewsOf(heatmap), [heatmap]);
  const shownPlan = planViews.find((plan) => plan.id === selectedPlanId) ?? planViews[0] ?? null;
  const sensorPoints = useMemo(() => heatmap?.sensor_points ?? [], [heatmap]);
  const viewPoints = useMemo(
    () => viewPointsOf(sensorPoints, planViews, shownPlan),
    [planViews, sensorPoints, shownPlan],
  );
  const viewHeatmap = useMemo(
    () => viewHeatmapOf(heatmap, planViews, shownPlan, viewPoints),
    [heatmap, planViews, shownPlan, viewPoints],
  );
  const sensorLines = useMemo(
    () =>
      visualization === 'lines'
        ? sensorLinesOf(viewPoints, (row) => t('status_line_label', { line: row + 1 }))
        : [],
    [t, viewPoints, visualization],
  );
  const zonePoints = useMemo(
    () =>
      zonePointsOf({
        points: viewPoints,
        lines: visualization === 'lines' ? sensorLines : null,
        heatmap,
        frameIndex,
        threshold,
      }),
    [frameIndex, heatmap, sensorLines, threshold, viewPoints, visualization],
  );
  // Once per loaded heatmap - moving the slider then only looks values up.
  const sensorStats = useMemo(() => sensorStatsOf(heatmap), [heatmap]);
  const sensorRows = useMemo(
    () =>
      sensorRowsOf({
        heatmap,
        frameIndex,
        stats: sensorStats,
        hasMeasurePoints: sensorPoints.length > 0,
        points: viewPoints,
        lines: sensorLines,
        threshold,
      }),
    [frameIndex, heatmap, sensorLines, sensorPoints.length, sensorStats, threshold, viewPoints],
  );

  const sensorTable = withSensorTable && (
    <div style={{ marginTop: 14 }}>
      <SensorListTable rows={sensorRows} />
    </div>
  );

  const content = () => {
    if (denied) {
      return <PlanHint>{t('status_no_measurement_access')}</PlanHint>;
    }
    if (!shownPlan) {
      return <PlanHint>{t('status_no_lageplan')}</PlanHint>;
    }
    if (sensorPoints.length === 0) {
      return <SensorListTable rows={sensorRows} />;
    }
    if (visualization === 'heatmap') {
      return (
        <>
          <div
            style={{
              position: 'relative',
              borderRadius: 14,
              background: 'var(--progeo-surface)',
              overflow: 'hidden',
            }}
          >
            <SensorHeatmap2D
              response={viewHeatmap}
              height={480}
              hideChrome
              onTimestampChange={setFrameIndex}
              alarms={alarmSpans}
            />
          </div>
          {sensorTable}
        </>
      );
    }
    return (
      <>
        {heatmap && frameTotal > 0 && frameIndex != null && (
          <div className="px-2 py-2">
            <FrameSlider
              id="plan-frame"
              timestamps={heatmap.timestamps}
              index={Math.min(frameIndex, frameTotal - 1)}
              onChange={setFrameIndex}
              alarms={alarmSpans}
            />
          </div>
        )}
        <LageplanZoneOverlay
          imageUrl={shownPlan.url ?? null}
          points={zonePoints}
          height={480}
          mode={visualization}
        />
        {sensorTable}
      </>
    );
  };

  return (
    <PanelCard
      title={t('status_dachansicht_title')}
      actions={
        planViews.length > 1 ? (
          <SegmentedControl
            options={planViews.map((plan, index) => ({
              value: String(plan.id),
              label: plan.name || t('status_plan_view', { index: index + 1 }),
            }))}
            value={String(shownPlan?.id)}
            onChange={(value) => setSelectedPlanId(Number(value))}
          />
        ) : undefined
      }
    >
      {content()}
    </PanelCard>
  );
};

export default LocationPlanPanel;
