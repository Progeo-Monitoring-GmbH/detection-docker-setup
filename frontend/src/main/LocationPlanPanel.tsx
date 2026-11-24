import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import FrameSlider, {
  focusFrameIndex,
  type AlarmSpan,
} from '../components/device/FrameSlider';
import LageplanZoneOverlay from '../components/device/LageplanZoneOverlay';
import SensorHeatmap2D from '../components/device/SensorHeatmap2D';
import SensorListTable from '../components/device/SensorListTable';
import SensorStatusTiles from '../components/device/SensorStatusTiles';
import type { SuspicionPlanMarker } from '../components/device/SuspicionMarkers';
import { suspicionsAtFrame, suspicionsOnPlan } from './computedSuspicion';
import type {
  HeatProfile,
  SensorHeatmapResponse,
} from '../components/device/sensorHeatmapTypes';
import PanelCard from '../components/ui/kit/PanelCard';
import {
  FullscreenButton,
  FullscreenFrame,
  useFullscreen,
} from '../components/ui/kit/Fullscreen';
import PlotHelp from '../components/ui/PlotHelp';
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
import { childTestId } from '../testIds';
import './LocationPlanPanel.css';

type LocationPlanPanelProps = {
  /** The plan to show first (?plan=, planParam.ts) - the first one otherwise. */
  preferredPlanId?: number | null;
  /** A plan asked for on the page (a suspected leak's "Jump to Event"):
   * shown instead of preferredPlanId until another one is picked. */
  focusPlanId?: number | null;
  /** Raised to show focusPlanId again although a plan was picked since. */
  focusPlanRevision?: number;
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
  /** Staff: the same frames as another value per sensor (`profile`) - only
   * the heat shows it; null: the heat shows `heatmap`. */
  profileHeatmap?: SensorHeatmapResponse | null;
  profile?: HeatProfile;
  onProfileChange?: (profile: HeatProfile) => void;
  profileLoading?: boolean;
  /** A time of interest (ms, e.g. a notification's event): shown until a
   * frame is picked, while the frames reach back to it - else the newest. */
  focusTime?: number | null;
  /** Raised to show `focusTime` again although a frame was picked since
   * (a Verdachtsstelle's "first detection" asked for twice). */
  focusRevision?: number;
  /** Controls beside the frame slider's play button (the step width). */
  frameToolbar?: ReactNode;
  /** The sensor (pos) selected on the plan - marked there; a click on a
   * sensor reports it (the heatmap only). */
  selectedSensor?: number | null;
  onSensorSelect?: (pos: number) => void;
  /** A sensor (pos) pointed out on the plan - e.g. the one hovered in a
   * Verdachtsstelle's sensor list. */
  highlightedSensor?: number | null;
  /** smartex® mx-PEEL: the computed suspicion points - over the heat of the
   * view (Lageplan) they lie on. */
  suspicions?: SuspicionPlanMarker[];
  /** The time (ms) of the frame shown, whenever it changes (null: none) -
   * the page keeps it for an escalation (statusViewState.ts). */
  onFrameTimeChange?: (ms: number | null) => void;
  /** data-testid of the panel (default "plan-panel"); its parts derive from it. */
  testId?: string;
};

/**
 * The tallest the plan gets: it fills the card's width (height from the
 * plan's aspect), but stays within about three quarters of the window - a
 * tall plan keeps empty bands beside it instead of needing a scroll.
 */
const planMaxHeight = (windowHeight: number) =>
  Math.round(Math.min(900, Math.max(420, windowHeight * 0.75)));

const usePlanMaxHeight = () => {
  const [maxHeight, setMaxHeight] = useState(() =>
    planMaxHeight(window.innerHeight),
  );
  useEffect(() => {
    const onResize = () => setMaxHeight(planMaxHeight(window.innerHeight));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return maxHeight;
};

const PlanHint = ({
  children,
  testId,
}: {
  children: ReactNode;
  testId?: string;
}) => (
  <div className="plan-panel-hint" data-testid={testId}>
    {children}
  </div>
);

/**
 * "Dachansicht": the shown view (Lageplan) of the location with its sensors -
 * per product (see projectType.ts) a heatmap, or lines, segments or points
 * on the plan - and the sensor table, which follows the shown frame.
 * "Sensoransicht" instead for smartex® is and while the location has no
 * Lageplan: a status tile per sensor (SensorStatusTiles).
 */
const LocationPlanPanel = ({
  heatmap,
  visualization,
  withSensorTable,
  threshold,
  denied,
  alarmSpans,
  profileHeatmap = null,
  profile = 'diff',
  onProfileChange,
  profileLoading = false,
  focusTime = null,
  focusRevision = 0,
  frameToolbar,
  selectedSensor = null,
  onSensorSelect,
  highlightedSensor = null,
  suspicions,
  onFrameTimeChange,
  testId = 'plan-panel',
  preferredPlanId = null,
  focusPlanId = null,
  focusPlanRevision = 0,
}: LocationPlanPanelProps) => {
  const { t } = useTranslation();
  const fullscreen = useFullscreen();
  const maxHeight = usePlanMaxHeight();
  // smartex® dm: the heat field too, with its band lines (SensorHeatmap2D).
  const withHeat = visualization === 'heatmap' || visualization === 'lines';
  // A plan picked here wins - until another one is asked for (preferredPlanId,
  // or a jump's focusPlanId - the newer one).
  const [pickedPlan, setPickedPlan] = useState<{
    from: number | null;
    focus: number;
    id: number;
  } | null>(null);
  const selectedPlanId =
    pickedPlan &&
    pickedPlan.from === preferredPlanId &&
    pickedPlan.focus === focusPlanRevision
      ? pickedPlan.id
      : (focusPlanId ?? preferredPlanId);
  // The frame the plan shows (its slider). The heatmap reports its own; the
  // overlays show the newest whenever the frames change (`picked.heatmap`).
  const [picked, setPicked] = useState<{
    heatmap: SensorHeatmapResponse | null;
    focus: number;
    index: number | null;
  }>({ heatmap: null, focus: 0, index: null });
  const frameTotal = heatmap?.timestamps.length ?? 0;
  // Until a frame is picked: the one of the time of interest, else the newest.
  const startFrame =
    (heatmap ? focusFrameIndex(heatmap.timestamps, focusTime) : null) ??
    (frameTotal > 0 ? frameTotal - 1 : null);
  const frameIndex =
    withHeat || (picked.heatmap === heatmap && picked.focus === focusRevision)
      ? picked.index
      : startFrame;
  // Stable per heatmap: SensorHeatmap2D reports its frame from an effect on it.
  const setFrameIndex = useCallback(
    (index: number | null) =>
      setPicked((prev) =>
        prev.heatmap === heatmap &&
        prev.focus === focusRevision &&
        prev.index === index
          ? prev
          : { heatmap, focus: focusRevision, index },
      ),
    [focusRevision, heatmap],
  );

  // The frame's time, told to the page (its timestamps are seconds).
  const frameTime =
    heatmap && frameIndex != null
      ? (heatmap.timestamps[frameIndex] ?? null)
      : null;
  const onFrameTimeRef = useRef(onFrameTimeChange);
  useLayoutEffect(() => {
    onFrameTimeRef.current = onFrameTimeChange;
  });
  useEffect(() => {
    onFrameTimeRef.current?.(frameTime != null ? frameTime * 1000 : null);
  }, [frameTime]);

  const planViews = useMemo(() => planViewsOf(heatmap), [heatmap]);
  const shownPlan =
    planViews.find((plan) => plan.id === selectedPlanId) ??
    planViews[0] ??
    null;
  // The suspected leaks of the shown view - only on the frames they were
  // detected in.
  const shownSuspicions = useMemo(
    () =>
      suspicionsAtFrame(
        suspicionsOnPlan(suspicions, shownPlan?.id ?? null),
        heatmap?.timestamps,
        frameIndex,
      ),
    [suspicions, shownPlan, heatmap, frameIndex],
  );
  const sensorPoints = useMemo(() => heatmap?.sensor_points ?? [], [heatmap]);
  const viewPoints = useMemo(
    () => viewPointsOf(sensorPoints, planViews, shownPlan),
    [planViews, sensorPoints, shownPlan],
  );
  // The heat: the picked profile's frames, else the plan's.
  const viewHeatmap = useMemo(
    () =>
      viewHeatmapOf(
        profileHeatmap ?? heatmap,
        planViews,
        shownPlan,
        viewPoints,
      ),
    [heatmap, profileHeatmap, planViews, shownPlan, viewPoints],
  );
  const sensorLines = useMemo(
    () =>
      visualization === 'lines'
        ? sensorLinesOf(viewPoints, (row) =>
            t('status_line_label', { line: row + 1 }),
          )
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
    [
      frameIndex,
      heatmap,
      sensorLines,
      sensorPoints.length,
      sensorStats,
      threshold,
      viewPoints,
    ],
  );

  // "Sensoransicht": smartex® is, and every product while the location has
  // no Lageplan - a status tile per sensor (each once, every view's).
  const asTiles =
    !denied && (visualization === 'tiles' || (heatmap != null && !shownPlan));
  const tileRows = useMemo(() => {
    if (!asTiles) {
      return [];
    }
    const seen = new Set<number>();
    const points = sensorPoints.filter(
      (point) => !seen.has(point.pos) && Boolean(seen.add(point.pos)),
    );
    return sensorRowsOf({
      heatmap,
      frameIndex: null, // the newest reading of each sensor
      stats: sensorStats,
      hasMeasurePoints: points.length > 0,
      points,
      lines: [],
      threshold,
    });
  }, [asTiles, heatmap, sensorPoints, sensorStats, threshold]);

  const sensorTable = withSensorTable && (
    <div
      className="plan-panel-sensor-table"
      data-testid={childTestId(testId, 'sensor-table')}
    >
      <SensorListTable rows={sensorRows} />
    </div>
  );

  const content = () => {
    if (denied) {
      return (
        <PlanHint testId={childTestId(testId, 'denied')}>
          {t('status_no_measurement_access')}
        </PlanHint>
      );
    }
    if (asTiles) {
      return (
        <SensorStatusTiles
          rows={tileRows}
          testId={childTestId(testId, 'tiles')}
        />
      );
    }
    if (!shownPlan) {
      return (
        <PlanHint testId={childTestId(testId, 'no-plan')}>
          {t('status_no_lageplan')}
        </PlanHint>
      );
    }
    if (sensorPoints.length === 0) {
      return <SensorListTable rows={sensorRows} />;
    }
    if (withHeat) {
      return (
        <>
          <div
            className="plan-panel-heatmap"
            data-testid={childTestId(testId, 'heatmap')}
          >
            <SensorHeatmap2D
              response={viewHeatmap}
              // Full card width; as tall as the shown area needs, up to maxHeight.
              height={maxHeight}
              hideChrome
              onTimestampChange={setFrameIndex}
              alarms={alarmSpans}
              profile={profile}
              onProfileChange={onProfileChange}
              profileLoading={profileLoading}
              focusTime={focusTime}
              focusRevision={focusRevision}
              frameToolbar={frameToolbar}
              // The clicked sensor: the white "selected" ring (lila marks active ones).
              focusedPosition={selectedSensor}
              highlightedPosition={highlightedSensor}
              onSensorClick={onSensorSelect}
              suspicions={shownSuspicions}
            />
          </div>
          {sensorTable}
        </>
      );
    }
    return (
      <>
        {heatmap && frameTotal > 0 && frameIndex != null && (
          <div
            className="px-2 py-2"
            data-testid={childTestId(testId, 'frame-slider')}
          >
            <FrameSlider
              id="plan-frame"
              timestamps={heatmap.timestamps}
              index={Math.min(frameIndex, frameTotal - 1)}
              onChange={setFrameIndex}
              alarms={alarmSpans}
              toolbar={frameToolbar}
            />
          </div>
        )}
        <LageplanZoneOverlay
          imageUrl={shownPlan.url ?? null}
          points={zonePoints}
          height={maxHeight}
          fitWidth
          // 'tiles' never gets here (asTiles above) - points keeps the type whole.
          mode={visualization === 'tiles' ? 'points' : visualization}
          alignment={shownPlan}
          highlightedPosition={highlightedSensor}
        />
        {sensorTable}
      </>
    );
  };

  return (
    // The plan on the whole screen - on a phone the only way to read it.
    <FullscreenFrame state={fullscreen}>
      <PanelCard
        testId={testId}
        title={
          asTiles
            ? t('status_sensoransicht_title')
            : t('status_dachansicht_title')
        }
        actions={
          <>
            {!asTiles && planViews.length > 1 && (
              <SegmentedControl
                testId={childTestId(testId, 'plans')}
                options={planViews.map((plan, index) => ({
                  value: String(plan.id),
                  label:
                    plan.name || t('status_plan_view', { index: index + 1 }),
                }))}
                value={String(shownPlan?.id)}
                onChange={(value) =>
                  setPickedPlan({
                    from: preferredPlanId,
                    focus: focusPlanRevision,
                    id: Number(value),
                  })
                }
              />
            )}
            {!asTiles && (
              <FullscreenButton
                state={fullscreen}
                testId={childTestId(testId, 'fullscreen')}
              />
            )}
            <PlotHelp
              topic="status_plan"
              testId={childTestId(testId, 'help')}
            />
          </>
        }
      >
        {content()}
      </PanelCard>
    </FullscreenFrame>
  );
};

export default LocationPlanPanel;
