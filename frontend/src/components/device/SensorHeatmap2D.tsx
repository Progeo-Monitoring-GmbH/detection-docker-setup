import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from 'react-bootstrap';
import FrameSlider, { type AlarmSpan, frameAt } from './FrameSlider';
import { seriesRange } from './heatmapGrid';
import { heatColorAt, heatColorTable } from './heatmapCanvas';
import {
  chartFrame,
  chartLayout,
  cursorTarget,
  frameWeights,
  heatReference,
  hoverTarget,
  isOverDrawn,
  planLocation,
  plotSensors,
  sensorsInRect,
  seriesPeak,
  type FieldRange,
  type ChartSensor,
} from './heatmapChart';
import {
  drawScene,
  heatFieldCanvas,
  renderSceneFrame,
  sizedContext,
  type Scene,
} from './heatmapScene';
import { formatMeters } from './planMeters';
import { toWorld } from './heatmapCanvas';
import { HeatLimitationBar, HeatLimitationLayer, useHeatLimitationEditor } from './HeatLimitationEditor';
import { limitPolygons, toPlanPoint } from './heatLimitations';
import HeatmapToolbar from './HeatmapToolbar';
import SensorTooltip from './SensorTooltip';
import type { HeatProfile, SensorHeatmapLocation, SensorHeatmapResponse } from './sensorHeatmapTypes';
import HeatmapDisplayControls from './HeatmapDisplayControls';
import { useHeatmapFrameExport } from './useHeatmapFrameExport';
import { useHeatSigma } from './useHeatSigma';
import { type AreaRect, useHeatmapViewport, usePanZoomGestures } from './useHeatmapViewport';
import { useLageplanImage } from './useLageplanImage';
import ZoomControls from './ZoomControls';
import { childTestId } from '../../testIds';
import { TWO_FINGER_TOUCH_ACTION, useWheelHint, WheelZoomHint } from '../ui/wheelZoom';
import { getBackendUrl } from '../../backendUrl';
import { useAuth } from '../../../hooks/CoreAuthProvider';
import { staffFlags } from '../../main/access';
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
  /** The pos (sensor_order) of the selected sensors - e.g. those of the
   * measurements' second plot - drawn with a pink border. */
  selectedPositions?: number[];
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
   * data-testid of the heatmap (its card); its parts are "<testId>-plot",
   * "-canvas", "-toolbar", "-frame-slider", "-zoom", ... With the default,
   * the area rectangle, the display controls and the heat limitations keep
   * their own ids ("heatmap-area-rect", "heatmap-display-controls",
   * "heat-limit-*"); with another one they are scoped under it too.
   */
  testId?: string;
};

const DEFAULT_TEST_ID = 'sensor-heatmap';

/** The plan under the cursor: the position in meters and the heat there
 * (with the cursor, for the reference guides). */
type CursorHover = {
  kind: 'cursor';
  meters: [number, number] | null;
  heat: number | null;
  cursor: [number, number];
};

/** What the cursor points at: a sensor (by its pos) - with the plan under
 * the cursor too, so the position still shows - else only the plan. */
type Hover =
  | {
      kind: 'sensor';
      pos: number;
      screen: [number, number];
      meters: [number, number] | null;
      under: CursorHover | null;
    }
  | CursorHover;

/** Field mode: the colour scale (over all frames) and how readings show. */
type FieldScale = { range: FieldRange; unit: string; decimals: number };

const ZOOM_STEP = 1.4;

/** Field mode: the reading a grid value (0..1 of the scale) stands for. */
const fieldReading = ({ range }: FieldScale, heat: number) => range.min + heat * (range.max - range.min);

/** Field mode: a reading with its unit, e.g. "54.3 %". */
const formatReading = ({ decimals, unit }: FieldScale, value: number) =>
  `${value.toFixed(decimals)} ${unit}`.trim();

/** The picked Lageplan of `plans`, for the plans it was picked from - new
 * plans start with the first. */
const usePlanChoice = <T,>(plans: T[] | null) => {
  const [choice, setChoice] = useState<{ plans: T[] | null; index: number } | null>(null);
  const index = plans && choice?.plans === plans ? Math.min(choice.index, plans.length - 1) : 0;
  const choose = (next: number) => setChoice({ plans, index: next });
  return [index, choose] as const;
};

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
 * The plan's heat limitations cut the heat field off outside their areas;
 * staff and superusers draw, edit and delete them right on the plan
 * (HeatLimitationEditor.tsx).
 *
 * Geometry and heat field: heatmapChart.ts, drawing: heatmapScene.ts.
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
  toolbarStart,
  alarms,
  field,
  fitPlan = false,
  compact = fitPlan,
  highlightedDevice = null,
  selectedPositions,
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
  testId = DEFAULT_TEST_ID,
}: SensorHeatmap2DProps) => {
  const { t } = useTranslation();
  // The parts with an id of their own keep it while the heatmap has the default id.
  const ownId = testId === DEFAULT_TEST_ID;
  // Primitives, so a new `field` object per render doesn't recompute.
  const fieldUnit = field?.unit ?? null;
  const fieldDecimals = field?.decimals ?? 1;
  const fieldMode = fieldUnit != null;
  const [hover, setHover] = useState<Hover | null>(null);
  // What is drawn (the floating controls): the dots, the dm band lines and -
  // staff - the heat normalized to the period's highest value.
  const [showDots, setShowDots] = useState(true);
  const [showLines, setShowLines] = useState(true);
  const [normalize, setNormalize] = useState(false);
  // Area selection: the mode (drag selects instead of moving the plan) and
  // the rectangle being dragged.
  const [areaMode, setAreaMode] = useState(false);
  const [areaRect, setAreaRect] = useState<AreaRect | null>(null);

  // ---------------------------------------------------------------- frames

  const timestamps = useMemo(
    () => (Array.isArray(response?.timestamps) ? response.timestamps : []),
    [response],
  );
  // The frame picked on the own slider - for these timestamps only: new
  // data (another period or step) starts at the newest frame again.
  const [ownPick, setOwnPick] = useState<{ timestamps: number[]; index: number } | null>(null);
  const ownIndex = ownPick?.timestamps === timestamps ? ownPick.index : timestamps.length - 1;
  // Coupled (onTimeChange): the frame holding `time`.
  const timestampIndex = !onTimeChange
    ? ownIndex
    : time == null
      ? timestamps.length - 1
      : frameAt(timestamps, time);
  const setTimestampIndex = useCallback(
    (index: number) => {
      if (!onTimeChange) {
        setOwnPick({ timestamps, index });
      } else if (index >= 0 && index < timestamps.length) {
        onTimeChange(timestamps[index] * 1000);
      }
    },
    [onTimeChange, timestamps],
  );
  // The shown frame, within the timestamps there are.
  const frameIndex = Math.max(0, Math.min(timestampIndex, timestamps.length - 1));
  useEffect(() => {
    onTimestampChange?.(frameIndex);
  }, [onTimestampChange, frameIndex]);

  // ---------------------------------------------------------------- plan

  /** Alignment from the view (with_sliders mode) takes precedence over the list. */
  const baseLocation = alignment ?? response?.location ?? null;
  /** All lageplans of the location (may be several - user can swap between them). */
  const plans = useMemo(() => {
    const list = baseLocation?.lageplans;
    return Array.isArray(list) && list.length > 0 ? list : null;
  }, [baseLocation]);
  const [ownPlanIndex, chooseOwnPlan] = usePlanChoice(plans);
  const planIndex = onPlanChange
    ? Math.max(plans?.findIndex((plan) => plan.id === planId) ?? 0, 0)
    : ownPlanIndex;
  const choosePlan = (index: number) => {
    const picked = plans?.[index]?.id;
    if (!onPlanChange) {
      chooseOwnPlan(index);
    } else if (picked != null) {
      onPlanChange(picked);
    }
  };
  const activePlan = plans?.[planIndex] ?? null;
  const location = useMemo(() => planLocation(baseLocation, activePlan), [baseLocation, activePlan]);

  const image = useLageplanImage(location?.lageplan_url ? getBackendUrl(location.lageplan_url) : null);
  const imageSize = useMemo(
    () => (image ? { width: image.naturalWidth, height: image.naturalHeight } : null),
    [image],
  );

  // Heat limitations of the plan: staff and superusers draw them on the plan
  // image (not in the alignment wizard mode).
  const auth = useAuth();
  const canEditLimits = staffFlags(auth?.user).isStaffOrSuperuser;
  // σ of the plan (null: Auto σ) - staff change and store it, not in the
  // alignment wizard.
  const canEditSigma = canEditLimits && !alignment;
  const [sigma, setSigma] = useHeatSigma({ plan: activePlan, editable: canEditSigma });
  const limitEditor = useHeatLimitationEditor({
    plans,
    plan: activePlan,
    editable: canEditLimits && !alignment && image != null,
  });
  const drawing = limitEditor.draft != null;

  // ---------------------------------------------------------------- chart

  const flipY = Boolean(location?.flip_y);
  const sensors = useMemo(() => plotSensors(response, flipY), [response, flipY]);

  // Field mode: one colour scale for every frame, so the frames compare.
  const fieldScale = useMemo<FieldScale | null>(
    () =>
      fieldUnit != null
        ? {
            unit: fieldUnit,
            decimals: fieldDecimals,
            range: seriesRange(
              sensors.map((sensor) => sensor.series),
              10 ** (1 - fieldDecimals),
            ) ?? { min: 0, max: 1 },
          }
        : null,
    [fieldUnit, fieldDecimals, sensors],
  );

  // The same for every frame - only the heat field follows the slider.
  const layout = useMemo(
    () => chartLayout({ sensors, resolution, location, imageSize, fitPlan, fieldMode }),
    [sensors, resolution, location, imageSize, fitPlan, fieldMode],
  );
  // WP, EP and WP + EP have no threshold to scale against: always normalized.
  const normalizeForced = profile !== 'diff' || forceNormalize;
  const normalized = !fieldMode && (normalize || normalizeForced);
  // Normalized: the period's highest reading saturates the field (frames
  // stay comparable); else a multiple of the alarm threshold.
  const heatScale = useMemo(
    () => (normalized ? seriesPeak(sensors) : heatReference(location)),
    [normalized, sensors, location],
  );
  const frame = useMemo(
    () =>
      layout && timestamps.length > 0
        ? chartFrame(layout, frameWeights(sensors, frameIndex, fieldMode), {
            sigma,
            heatReference: heatScale,
            fieldRange: fieldScale?.range ?? null,
          })
        : null,
    [layout, timestamps.length, sensors, frameIndex, fieldMode, sigma, heatScale, fieldScale],
  );
  const hasLines = Boolean(layout?.lines.some((line) => line != null));

  const colorTable = useMemo(() => heatColorTable(), []);
  const heatCanvas = useMemo(
    () => (frame ? heatFieldCanvas(frame, colorTable) : null),
    [frame, colorTable],
  );
  // Only on the plan image - without one the areas have nothing to refer to.
  const limits = useMemo(
    () => (layout && image ? limitPolygons(limitEditor.shownAreas, layout.world) : []),
    [layout, image, limitEditor.shownAreas],
  );

  const scene = useMemo<Scene | null>(
    () =>
      layout && frame
        ? {
            layout,
            frame,
            image,
            heatCanvas,
            colorTable,
            // Field mode: the sensors are devices - named like their lines in
            // the climate charts; otherwise the sensor number.
            sensorText: (index) => {
              const sensor = layout.sensors[index];
              return fieldMode ? (sensor.label ?? sensor.name ?? String(sensor.pos)) : String(sensor.pos);
            },
            scaleTitle:
              fieldScale?.unit ??
              heatTitle ??
              (profile === 'diff' ? t('heatmap_heat') : t(`heatmap_profile_${profile}`)),
            tickLabel: (value) =>
              fieldScale ? fieldReading(fieldScale, value).toFixed(fieldScale.decimals) : value.toFixed(1),
            limits,
            showSensors: showDots,
            showLines: hasLines && showLines,
          }
        : null,
    [layout, frame, image, heatCanvas, colorTable, fieldMode, fieldScale, t, limits, profile, heatTitle, showDots, hasLines, showLines],
  );

  // ---------------------------------------------------------------- viewport

  const { wrapRef, width, canvasHeight, view, isZoomed, setView, zoomBy } = useHeatmapViewport({
    bounds: scene?.layout.bounds ?? null,
    height,
    fitPlan,
    compact,
  });

  // The device last reported to onHoverDevice - pointer moves report changes only.
  const reportedDevice = useRef<number | null>(null);
  const reportHoveredDevice = (device: number | null) => {
    if (reportedDevice.current !== device) {
      reportedDevice.current = device;
      onHoverDevice?.(device);
    }
  };

  const updateHover = (sx: number, sy: number) => {
    if (!scene || !view) {
      return;
    }
    const target = hoverTarget(scene.layout, scene.frame, view, location, imageSize, sx, sy);
    if (target?.kind === 'sensor') {
      const sensor = scene.layout.sensors[target.index];
      reportHoveredDevice(sensor.device);
      const under = cursorTarget(scene.layout, scene.frame, view, location, sx, sy);
      setHover({
        kind: 'sensor',
        pos: sensor.pos,
        screen: target.screen,
        meters: target.meters,
        under: under ? { ...under, cursor: [sx, sy] } : null,
      });
      return;
    }
    reportHoveredDevice(null);
    setHover(target ? { ...target, cursor: [sx, sy] } : null);
  };

  const clearHover = () => {
    setHover(null);
    reportHoveredDevice(null);
  };

  // Ctrl + wheel zooms; the plain wheel over the plan shows how (wheelZoom).
  const [wheelHint, showWheelHint] = useWheelHint();
  const oneFingerTool = drawing || areaMode;
  const { canvasRef, grabbing, handlers } = usePanZoomGestures({
    enabled: scene != null,
    view,
    setView,
    zoomBy,
    onHover: updateHover,
    onLeave: clearHover,
    onTap: (sx, sy) => {
      if (scene && view && drawing) {
        // Drawing a heat limitation: every click on the plan is a point.
        limitEditor.addPoint(toPlanPoint(toWorld(view, sx, sy), scene.layout.world), scene.layout.world);
        return;
      }
      if (!scene || !view || !onSensorClick) {
        return;
      }
      const target = hoverTarget(scene.layout, scene.frame, view, location, imageSize, sx, sy);
      if (target?.kind === 'sensor') {
        onSensorClick(scene.layout.sensors[target.index].pos);
      }
    },
    wheelZoomsAt: (sx, sy) => Boolean(scene && view && isOverDrawn(scene.layout, view, image != null, sx, sy)),
    onPlainWheel: showWheelHint,
    // Drawing a limitation or selecting an area: one finger is the tool.
    // Otherwise one finger scrolls the page, two move the plan.
    oneFingerPans: oneFingerTool,
    onOneFingerTouch: () => showWheelHint('touch'),
    area: onAreaSelect
      ? {
          starts: (event) => !drawing && (areaMode || event.shiftKey),
          onChange: setAreaRect,
          onSelect: (rect) => {
            if (scene && view) {
              onAreaSelect(sensorsInRect(scene.layout, view, rect).map((index) => scene.layout.sensors[index].pos));
            }
          },
        }
      : undefined,
  });

  // ---------------------------------------------------------------- drawing

  const sensorIndex = (match: (sensor: Scene['layout']['sensors'][number]) => boolean) => {
    const index = scene?.layout.sensors.findIndex(match) ?? -1;
    return index >= 0 ? index : null;
  };
  const hoveredIndex = hover?.kind === 'sensor' ? sensorIndex((sensor) => sensor.pos === hover.pos) : null;
  const highlightedIndex =
    highlightedDevice != null ? sensorIndex((sensor) => sensor.device === highlightedDevice) : null;
  const sceneSensors = scene?.layout.sensors;
  const selectedIndices = useMemo(() => {
    const positions = new Set(selectedPositions ?? []);
    return new Set(
      (sceneSensors ?? []).flatMap((sensor, index) => (positions.has(sensor.pos) ? [index] : [])),
    );
  }, [sceneSensors, selectedPositions]);
  // The plan under the cursor - also while it is over a sensor.
  const underCursor = hover?.kind === 'sensor' ? hover.under : hover;
  // The guides only lead to a position in meters.
  const guideCursor = underCursor?.meters ? underCursor.cursor : null;

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !scene || !view || width <= 0) {
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    const ctx = sizedContext(canvas, width, canvasHeight, dpr);
    if (ctx) {
      drawScene(
        ctx,
        scene,
        { width, height: canvasHeight, dpr },
        view,
        { hovered: hoveredIndex, highlighted: highlightedIndex, selected: selectedIndices, cursor: guideCursor },
        null,
      );
    }
  }, [canvasRef, scene, view, width, canvasHeight, hoveredIndex, highlightedIndex, selectedIndices, guideCursor]);

  // ---------------------------------------------------------------- export

  // The export loop keeps the functions it started with: it must still draw
  // the frame the slider shows now, so they go through a ref.
  const exportRef = useRef<{
    renderFrame: (width: number, height: number) => HTMLCanvasElement | null;
    afterDraw: (() => void) | null;
  }>({ renderFrame: () => null, afterDraw: null });
  const captureFrame = useCallback(
    (frameWidth: number, frameHeight: number) => exportRef.current.renderFrame(frameWidth, frameHeight),
    [],
  );
  const frameSize = useCallback(
    () => (width > 0 ? { width, height: canvasHeight } : null),
    [width, canvasHeight],
  );

  const videoExport = useHeatmapFrameExport({
    captureFrame,
    frameSize,
    chartReady: scene != null,
    timestamps,
    timestampIndex: frameIndex,
    setTimestampIndex,
  });

  useLayoutEffect(() => {
    exportRef.current = {
      renderFrame: (frameWidth, frameHeight) =>
        scene && view && width > 0
          ? renderSceneFrame(scene, view, { width, height: canvasHeight }, frameWidth, frameHeight)
          : null,
      afterDraw: videoExport.handleAfterPlot,
    };
  });
  // The export waits for each timestamp's frame to be drawn.
  useEffect(() => {
    exportRef.current.afterDraw?.();
  }, [frame]);

  // ---------------------------------------------------------------- render

  const body = scene ? (
    <>
      <div className="px-2 pt-2">
        {/* The Lageplan switcher is hidden in the alignment wizard mode
            (alignment prop takes precedence) and when the parent shows its own
            (onPlanChange). */}
        <HeatmapToolbar
          start={toolbarStart}
          middle={
            <HeatLimitationBar editor={limitEditor} testId={ownId ? undefined : childTestId(testId, 'heat-limit')} />
          }
          plans={alignment || onPlanChange ? null : plans}
          planIndex={planIndex}
          onPlanChange={choosePlan}
          sigma={canEditSigma ? { value: sigma, onChange: setSigma } : undefined}
          testId={childTestId(testId, 'toolbar')}
          video={{
            exporting: videoExport.videoExporting,
            stage: videoExport.videoStage,
            progress: videoExport.videoProgress,
            resultUrl: videoExport.videoResultUrl,
            download: videoExport.downloadVideoResult,
            start: videoExport.exportFrames,
            enabled: timestamps.length >= 2,
          }}
        />
        {!hideFrameSlider && (
          <div className="mt-1 pb-1">
            <FrameSlider
              id="heatmap2d-timestamp"
              timestamps={timestamps}
              index={frameIndex}
              onChange={setTimestampIndex}
              disabled={videoExport.videoExporting}
              alarms={alarms}
              testId={childTestId(testId, 'frame-slider')}
            />
          </div>
        )}
      </div>

      {videoExport.videoError && (
        <div className="text-danger small mb-2 px-2" data-testid={childTestId(testId, 'video-error')}>
          {videoExport.videoError}
        </div>
      )}

      {/* The outer box measures the width available; the plot is as wide as
          the canvas (narrower when compact, left-aligned - useHeatmapViewport). */}
      <div ref={wrapRef} className="heatmap2d-plot-area">
      <div
        className="heatmap2d-plot-wrap"
        data-testid={childTestId(testId, 'plot')}
        style={{ height: canvasHeight, width: width > 0 ? width : undefined }}
      >
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={t('heatmap_canvas_hint')}
          data-testid={childTestId(testId, 'canvas')}
          className={`heatmap2d-canvas heatmap2d-canvas--${
            drawing || areaMode ? 'crosshair' : hoveredIndex != null ? 'pointer' : grabbing ? 'grabbing' : 'grab'
          }`}
          style={{
            height: canvasHeight,
            touchAction: oneFingerTool ? 'none' : TWO_FINGER_TOUCH_ACTION,
          }}
          {...handlers}
          // While drawing, double clicks are two points - not a reset.
          onDoubleClick={() => !drawing && setView(null)}
        />

        {view && (
          <HeatLimitationLayer
            editor={limitEditor}
            view={view}
            world={scene.layout.world}
            width={width}
            height={canvasHeight}
            testId={ownId ? undefined : childTestId(testId, 'heat-limit')}
          />
        )}

        <WheelZoomHint visible={wheelHint} radius={0} testId={childTestId(testId, 'wheel-hint')} />
        {areaRect && (
          <div
            data-testid={ownId ? 'heatmap-area-rect' : childTestId(testId, 'area-rect')}
            className="heatmap2d-area-rect"
            style={{
              left: Math.min(areaRect[0], areaRect[2]),
              top: Math.min(areaRect[1], areaRect[3]),
              width: Math.abs(areaRect[2] - areaRect[0]),
              height: Math.abs(areaRect[3] - areaRect[1]),
            }}
          />
        )}
        <HeatmapDisplayControls
          dots={{ value: showDots, onChange: setShowDots }}
          area={onAreaSelect ? { value: areaMode, onChange: setAreaMode } : null}
          lines={hasLines ? { value: showLines, onChange: setShowLines } : null}
          normalize={
            canEditLimits && !fieldMode
              ? { value: normalize, onChange: setNormalize, forced: normalizeForced }
              : null
          }
          profile={
            canEditLimits && !fieldMode && onProfileChange
              ? { value: profile, onChange: onProfileChange, loading: profileLoading }
              : null
          }
          testId={ownId ? undefined : childTestId(testId, 'display')}
        />
        <ZoomControls
          onZoomIn={() => zoomBy(ZOOM_STEP)}
          onZoomOut={() => zoomBy(1 / ZOOM_STEP)}
          onReset={() => setView(null)}
          resetDisabled={!isZoomed}
          testId={childTestId(testId, 'zoom')}
        />

        {hover?.kind === 'sensor' && hoveredIndex != null && (
          <HoveredSensorTooltip
            sensor={scene.layout.sensors[hoveredIndex]}
            value={scene.frame.values[hoveredIndex]}
            meters={hover.meters}
            screen={hover.screen}
            fieldScale={fieldScale}
            colorTable={colorTable}
            containerWidth={width}
            containerHeight={canvasHeight}
            testId={childTestId(testId, 'sensor-tooltip')}
          />
        )}

        {underCursor && (
          <CursorReadout
            meters={underCursor.meters}
            heat={underCursor.heat}
            fieldScale={fieldScale}
            testId={childTestId(testId, 'readout')}
          />
        )}
      </div>
      </div>
    </>
  ) : (
    <div className="text-muted py-5 text-center" data-testid={childTestId(testId, 'empty')}>
      {t('heatmap_no_data')}
    </div>
  );

  if (hideChrome) {
    return body;
  }

  return (
    <Card className="border-0 shadow-sm" data-testid={testId}>
      <Card.Body>{body}</Card.Body>
    </Card>
  );
};

/** The tooltip of the hovered sensor - in field mode the sensors are
 * devices, named as in the climate charts, with the reading's colour. */
const HoveredSensorTooltip = ({
  sensor,
  value,
  meters,
  screen,
  fieldScale,
  colorTable,
  containerWidth,
  containerHeight,
  testId,
}: {
  sensor: ChartSensor;
  value: number;
  meters: [number, number] | null;
  screen: [number, number];
  fieldScale: FieldScale | null;
  colorTable: Uint8ClampedArray;
  containerWidth: number;
  containerHeight: number;
  testId?: string;
}) => {
  const range = fieldScale?.range;
  return (
    <SensorTooltip
      sensorPos={sensor.pos}
      name={fieldScale ? (sensor.label ?? sensor.name) : undefined}
      meters={meters}
      value={value}
      unit={fieldScale?.unit}
      decimals={fieldScale?.decimals}
      dotColor={
        range && range.max > range.min
          ? heatColorAt(colorTable, (value - range.min) / (range.max - range.min))
          : undefined
      }
      threshold={sensor.threshold}
      cursorX={screen[0]}
      cursorY={screen[1]}
      containerWidth={containerWidth}
      containerHeight={containerHeight}
      testId={testId}
    />
  );
};

/** Position in meters and heat (field mode: the reading) under the cursor,
 * bottom left on the plan. */
const CursorReadout = ({
  meters,
  heat,
  fieldScale,
  testId,
}: {
  meters: [number, number] | null;
  heat: number | null;
  fieldScale: FieldScale | null;
  testId?: string;
}) => {
  const { t } = useTranslation();
  const heatText = (value: number) =>
    fieldScale
      ? formatReading(fieldScale, fieldReading(fieldScale, value))
      : `${t('heatmap_heat')} ${value.toFixed(2)}`;
  return (
    <div className="heatmap2d-readout small" data-testid={testId}>
      {[meters ? formatMeters(meters) : null, heat == null ? null : heatText(heat)]
        .filter(Boolean)
        .join(' · ')}
    </div>
  );
};

export default SensorHeatmap2D;
