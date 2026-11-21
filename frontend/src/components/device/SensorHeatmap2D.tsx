import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from 'react-bootstrap';
import type { AlarmSpan } from './FrameSlider';
import { canvasCursor } from './heatmapMarkers';
import type {
  HeatProfile,
  SensorHeatmapLocation,
  SensorHeatmapResponse,
} from './sensorHeatmapTypes';
import {
  DEFAULT_HEATMAP_TEST_ID,
  HeatmapHeader,
  ownPartTestIds,
  PlotDisplayControls,
  PlotMarks,
  PlotPlaceholder,
  PlotPointerOverlays,
} from './SensorHeatmapParts';
import { useHeatmapFrames } from './useHeatmapFrames';
import { useHeatmapPlan, useStaffHeatSettings } from './useHeatmapPlan';
import { useHeatmapPointer } from './useHeatmapPointer';
import { useHeatmapDisplay, useHeatmapScene } from './useHeatmapScene';
import { useHeatmapViewport, usePanZoomGestures } from './useHeatmapViewport';
import {
  useDrawnScene,
  useHeldHeight,
  useSceneOverlay,
  useSceneVideoExport,
} from './useSceneCanvas';
import ZoomControls from './ZoomControls';
import type { SuspicionPlanMarker } from './SuspicionMarkers';
import { childTestId } from '../../testIds';
import {
  TWO_FINGER_TOUCH_ACTION,
  useWheelHint,
  WheelZoomHint,
} from '../ui/wheelZoom';
import './SensorHeatmap2D.css';

type SensorHeatmap2DProps = {
  response: SensorHeatmapResponse | null | undefined;
  title?: string;
  height?: number;
  resolution?: number;
  /** Overrides for the lageplan alignment (offset/scale) used in placement. */
  alignment?: SensorHeatmapLocation | null;
  /** Skip the component's own Card chrome so it can sit inside another panel wrapper. */
  hideChrome?: boolean;
  /** Called with the timestamp index the slider shows (also while exporting). */
  onTimestampChange?: (index: number) => void;
  /**
   * Couples the slider with another one (the measurements chart's): it shows
   * the frame holding `time` (epoch ms; the newest while null) and reports
   * the time picked here to `onTimeChange` instead of keeping it itself.
   */
  time?: number | null;
  onTimeChange?: (ms: number) => void;
  /** Leaves out the own slider - the page shows one for everything (with `time`). */
  hideFrameSlider?: boolean;
  /**
   * Not coupled (no `onTimeChange`): the frame shown until one is picked on
   * the slider - the one holding this time (epoch ms) while the frames reach
   * back to it, else the newest. E.g. the time of a notification's event.
   */
  focusTime?: number | null;
  /** Raised to show `focusTime` again although a frame was picked since
   * (e.g. the same moment asked for twice). */
  focusRevision?: number;
  /** Controls beside the slider's play button - e.g. the page's step width,
   * which only matters for the animation. */
  frameToolbar?: ReactNode;
  /** Controls of the page at the start of the toolbar row (e.g. its plan switcher). */
  toolbarStart?: ReactNode;
  /** Alarm periods, marked on the timestamp slider. */
  alarms?: AlarmSpan[];
  /**
   * Field mode, for readings that don't add up (LoRaWAN humidity and
   * temperature): instead of summed heat around each sensor, the readings
   * are interpolated between the sensors (buildFieldGrid) on a min-max
   * colour scale over all frames, labelled with `unit`.
   */
  field?: { unit: string; decimals?: number };
  /**
   * Show the whole Lageplan, fitted to the full width (the canvas grows as
   * tall as the plan needs) instead of the area around the sensors with
   * `height` as the upper bound.
   */
  fitPlan?: boolean;
  /**
   * The canvas only as wide as the plan needs at its height, left-aligned -
   * no empty bands beside it in a wide card. Default: with fitPlan.
   */
  compact?: boolean;
  /** Device (sensor_points[].device) whose marker is highlighted - e.g. the
   * line hovered in the climate charts. */
  highlightedDevice?: number | null;
  /** Sensor (pos, sensor_order) highlighted like `highlightedDevice` - e.g.
   * the one hovered in a Verdachtsstelle's sensor list. */
  highlightedPosition?: number | null;
  /** The pos (sensor_order) of the selected (active) sensors - e.g. those
   * of the measurements' second plot - drawn with a lila ring. */
  selectedPositions?: number[];
  /** The pos of the one focused sensor (the one picked last) - a white ring. */
  focusedPosition?: number | null;
  /** Called with the device of the hovered marker, null when it is left. */
  onHoverDevice?: (device: number | null) => void;
  /** Called with the pos (sensor_order) of a clicked sensor marker. */
  onSensorClick?: (pos: number) => void;
  /**
   * Staff: the value per sensor `response` holds (?profile=) - the parent
   * loads it; picking another one calls `onProfileChange`. Without it the
   * profile isn't offered.
   */
  profile?: HeatProfile;
  onProfileChange?: (profile: HeatProfile) => void;
  /** While the picked profile loads. */
  profileLoading?: boolean;
  /**
   * Area selection: a rectangle dragged over the plan (in the select mode of
   * the controls, or with Shift) reports the pos (sensor_order) of the
   * sensors in it. Without it there is no area selection.
   */
  onAreaSelect?: (positions: number[]) => void;
  /** Title of the colour scale instead of the profile's (e.g. a change). */
  heatTitle?: string;
  /** The heat is always normalized (e.g. a change has no threshold). */
  forceNormalize?: boolean;
  /**
   * The parent picks the Lageplan (e.g. to load only its sensors) and shows
   * the switcher: the id of the shown one (none / unknown: the first). With
   * `onPlanChange` the own switcher is left out; without it the component
   * keeps the pick itself.
   */
  planId?: number | null;
  onPlanChange?: (planId: number) => void;
  /**
   * The parent loads other data (e.g. another plan): the plot stays as it is,
   * dimmed under a spinner, and takes no input - instead of collapsing.
   */
  busy?: boolean;
  /** smartex® mx-PEEL: computed suspicion points, drawn as lettered rings
   * over the heat (SuspicionMarkers.tsx). */
  suspicions?: SuspicionPlanMarker[];
  /**
   * data-testid of the heatmap (its card); its parts are "<testId>-plot",
   * "-canvas", "-toolbar", "-frame-slider", "-zoom", ... With the default,
   * the area rectangle and the display controls keep their own ids
   * ("heatmap-area-rect", "heatmap-display-controls"); with another one they
   * are scoped under it too.
   */
  testId?: string;
};

const ZOOM_STEP = 1.4;

/**
 * Sensor heatmap on the Lageplan as a canvas: the plan image in the
 * background, the Gaussian heat field (buildWeightedGrid) on top, sensor
 * markers, the reference point and a colour scale. Zoom with the mouse wheel
 * (around the cursor) or the buttons, drag to move, pinch on touch devices,
 * double-click to reset. Hovering a sensor shows its tooltip, anywhere else
 * on the plan the position in meters (with the dotted guides from the
 * reference point) and the heat there. The video export draws its frames
 * from the same scene (renderSceneFrame).
 *
 * The plan's heat limitations cut the heat field off outside their areas -
 * they are drawn in the Lageplan wizard (HeatLimitationStage.tsx).
 *
 * Geometry and heat field: heatmapChart.ts, drawing: heatmapScene.ts, the
 * scene: useHeatmapScene.ts (colour scale: heatmapScale.ts), the pointer:
 * useHeatmapPointer.ts, the parts around the canvas: SensorHeatmapParts.tsx.
 */
const SensorHeatmap2D = ({
  response,
  height = 800,
  resolution = 180,
  alignment = null,
  hideChrome = false,
  onTimestampChange,
  time = null,
  onTimeChange,
  hideFrameSlider = false,
  focusTime = null,
  focusRevision = 0,
  frameToolbar,
  toolbarStart,
  alarms,
  field,
  fitPlan = false,
  compact = fitPlan,
  highlightedDevice = null,
  highlightedPosition = null,
  selectedPositions,
  focusedPosition = null,
  onHoverDevice,
  onSensorClick,
  profile = 'diff',
  onProfileChange,
  profileLoading = false,
  onAreaSelect,
  heatTitle,
  forceNormalize = false,
  planId = null,
  onPlanChange,
  busy = false,
  suspicions,
  testId = DEFAULT_HEATMAP_TEST_ID,
}: SensorHeatmap2DProps) => {
  const { t } = useTranslation();
  const partIds = ownPartTestIds(testId);
  const display = useHeatmapDisplay(field?.unit != null);

  const { timestamps, frameIndex, setFrameIndex } = useHeatmapFrames({
    response,
    time,
    onTimeChange,
    focusTime,
    focusRevision,
    onTimestampChange,
  });
  const {
    switchablePlans,
    planIndex,
    choosePlan,
    activePlan,
    location,
    image,
    imagePending,
  } = useHeatmapPlan({
    response,
    alignment,
    planId,
    onPlanChange,
  });
  const { staff, sigma, sigmaControl } = useStaffHeatSettings({
    activePlan,
    alignment,
  });

  const {
    scene,
    frame,
    imageSize,
    placedSuspicions,
    fieldMode,
    fieldScale,
    absoluteScale,
    normalizeForced,
    hasLines,
    colorTable,
  } = useHeatmapScene({
    response,
    location,
    activePlan,
    image,
    resolution,
    fitPlan,
    field,
    sigma,
    frameIndex,
    frameCount: timestamps.length,
    profile,
    forceNormalize,
    heatTitle,
    display,
    suspicions,
  });

  // ---------------------------------------------------------------- viewport

  const { wrapRef, width, canvasHeight, view, isZoomed, setView, zoomBy } =
    useHeatmapViewport({
      bounds: scene?.layout.bounds ?? null,
      height,
      fitPlan,
      compact,
    });
  const pointer = useHeatmapPointer({
    scene,
    view,
    location,
    imageSize,
    onHoverDevice,
    onSensorClick,
    onAreaSelect,
    areaMode: display.areaMode,
  });
  const { hover, areaRect } = pointer;

  // Ctrl + wheel zooms; the plain wheel over the plan shows how (wheelZoom).
  const [wheelHint, showWheelHint] = useWheelHint();
  // Selecting an area: one finger is the tool. Otherwise one finger scrolls
  // the page, two move the plan.
  const oneFingerTool = display.areaMode;
  // The canvas is there - not while a plan image loads (the placeholder holds its place).
  const plotShown = scene != null && !imagePending;
  // The height of the last plot shown - the placeholder keeps it.
  const heldHeight = useHeldHeight(plotShown && width > 0, canvasHeight);
  const { canvasRef, grabbing, handlers } = usePanZoomGestures({
    enabled: plotShown,
    view,
    setView,
    zoomBy,
    ...pointer.gestures,
    onPlainWheel: showWheelHint,
    oneFingerPans: oneFingerTool,
    onOneFingerTouch: () => showWheelHint('touch'),
  });

  // ---------------------------------------------------------------- drawing

  const overlay = useSceneOverlay(scene, hover, {
    highlightedDevice,
    highlightedPosition,
    selectedPositions,
    focusedPosition,
  });
  useDrawnScene(canvasRef, scene, view, width, canvasHeight, overlay);

  const videoExport = useSceneVideoExport({
    scene,
    frame,
    view,
    width,
    height: canvasHeight,
    timestamps,
    frameIndex,
    setFrameIndex,
  });

  // ---------------------------------------------------------------- render

  if (!scene) {
    return (
      <HeatmapChrome hideChrome={hideChrome} testId={testId}>
        <div
          className="text-muted py-5 text-center"
          data-testid={childTestId(testId, 'empty')}
        >
          {t('heatmap_no_data')}
        </div>
      </HeatmapChrome>
    );
  }

  return (
    <HeatmapChrome hideChrome={hideChrome} testId={testId}>
      <HeatmapHeader
        plans={switchablePlans}
        toolbarStart={toolbarStart}
        planIndex={planIndex}
        onPlanChange={choosePlan}
        sigma={sigmaControl}
        videoExport={videoExport}
        timestamps={timestamps}
        frameIndex={frameIndex}
        onFrameChange={setFrameIndex}
        hideFrameSlider={hideFrameSlider}
        alarms={alarms}
        frameToolbar={frameToolbar}
        testId={testId}
      />

      {/* The outer box measures the width available; the plot is as wide as
          the canvas (narrower when compact, left-aligned - useHeatmapViewport). */}
      <div ref={wrapRef} className="heatmap2d-plot-area">
        {imagePending ? (
          // The plan image loads: its place keeps the last plot's height.
          <PlotPlaceholder
            height={heldHeight}
            testId={childTestId(testId, 'plot-loading')}
          />
        ) : (
          <div
            className="heatmap2d-plot-wrap"
            data-testid={childTestId(testId, 'plot')}
            aria-busy={busy || undefined}
            style={{
              height: canvasHeight,
              width: width > 0 ? width : undefined,
            }}
          >
            <canvas
              ref={canvasRef}
              role="img"
              aria-label={t('heatmap_canvas_hint')}
              data-testid={childTestId(testId, 'canvas')}
              className={`heatmap2d-canvas heatmap2d-canvas--${canvasCursor({
                areaMode: display.areaMode,
                overSensor: overlay.hovered != null,
                grabbing,
              })}`}
              style={{
                height: canvasHeight,
                touchAction: oneFingerTool ? 'none' : TWO_FINGER_TOUCH_ACTION,
              }}
              {...handlers}
              onDoubleClick={() => setView(null)}
            />

            <WheelZoomHint
              visible={wheelHint}
              radius={0}
              testId={childTestId(testId, 'wheel-hint')}
            />
            <PlotMarks
              areaRect={areaRect}
              suspicions={placedSuspicions}
              view={view}
              width={width}
              height={canvasHeight}
              areaRectTestId={partIds.areaRect}
            />
            <PlotDisplayControls
              state={display}
              areaSelectable={Boolean(onAreaSelect)}
              hasLines={hasLines}
              heatOptions={staff && !fieldMode}
              normalizeForced={normalizeForced}
              profile={profile}
              onProfileChange={onProfileChange}
              profileLoading={profileLoading}
              testId={partIds.display}
            />
            <ZoomControls
              onZoomIn={() => zoomBy(ZOOM_STEP)}
              onZoomOut={() => zoomBy(1 / ZOOM_STEP)}
              onReset={() => setView(null)}
              resetDisabled={!isZoomed}
              testId={childTestId(testId, 'zoom')}
            />

            <PlotPointerOverlays
              scene={scene}
              hover={hover}
              hoveredIndex={overlay.hovered}
              fieldScale={fieldScale}
              absoluteScale={absoluteScale}
              colorTable={colorTable}
              width={width}
              height={canvasHeight}
              busy={busy}
              testId={testId}
            />
          </div>
        )}
      </div>
    </HeatmapChrome>
  );
};

/** The heatmap's Card - left out with `hideChrome` (inside another panel). */
const HeatmapChrome = ({
  hideChrome,
  testId,
  children,
}: {
  hideChrome: boolean;
  testId: string;
  children: ReactNode;
}) =>
  hideChrome ? (
    <>{children}</>
  ) : (
    <Card className="border-0 shadow-sm" data-testid={testId}>
      <Card.Body>{children}</Card.Body>
    </Card>
  );

export default SensorHeatmap2D;
