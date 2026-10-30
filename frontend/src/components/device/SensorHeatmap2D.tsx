import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from 'react-bootstrap';
import { plotTheme } from '../../styles/plotTheme';
import FrameSlider, { type AlarmSpan, frameAt } from './FrameSlider';
import { seriesRange } from './heatmapGrid';
import { heatColorAt, heatColorTable } from './heatmapCanvas';
import {
  chartFrame,
  chartLayout,
  frameWeights,
  heatReference,
  hoverTarget,
  isOverDrawn,
  planLocation,
  plotSensors,
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
import HeatmapToolbar from './HeatmapToolbar';
import SensorTooltip from './SensorTooltip';
import type { SensorHeatmapLocation, SensorHeatmapResponse } from './sensorHeatmapTypes';
import { useHeatmapFrameExport } from './useHeatmapFrameExport';
import { useHeatmapViewport, usePanZoomGestures } from './useHeatmapViewport';
import { useLageplanImage } from './useLageplanImage';
import ZoomControls from './ZoomControls';
import { getBackendUrl } from '../../backendUrl';

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
  /** Device (sensor_points[].device) whose marker is highlighted - e.g. the
   * line hovered in the climate charts. */
  highlightedDevice?: number | null;
  /** Called with the device of the hovered marker, null when it is left. */
  onHoverDevice?: (device: number | null) => void;
  /** Called with the pos (sensor_order) of a clicked sensor marker. */
  onSensorClick?: (pos: number) => void;
};

/** What the cursor points at: a sensor (by its pos), else the position in
 * meters and the heat there (with the cursor, for the reference guides). */
type Hover =
  | { kind: 'sensor'; pos: number; screen: [number, number]; meters: [number, number] | null }
  | {
      kind: 'cursor';
      meters: [number, number] | null;
      heat: number | null;
      cursor: [number, number];
    };

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
  alarms,
  field,
  fitPlan = false,
  highlightedDevice = null,
  onHoverDevice,
  onSensorClick,
}: SensorHeatmap2DProps) => {
  const { t } = useTranslation();
  // Primitives, so a new `field` object per render doesn't recompute.
  const fieldUnit = field?.unit ?? null;
  const fieldDecimals = field?.decimals ?? 1;
  const fieldMode = fieldUnit != null;
  const [sigma, setSigma] = useState<'auto' | number>('auto');
  const [hover, setHover] = useState<Hover | null>(null);

  // ---------------------------------------------------------------- frames

  const timestamps = useMemo(
    () => (Array.isArray(response?.timestamps) ? response.timestamps : []),
    [response],
  );
  const [ownIndex, setOwnIndex] = useState(0);
  // Coupled (onTimeChange): the frame holding `time`.
  const timestampIndex = !onTimeChange
    ? ownIndex
    : time == null
      ? timestamps.length - 1
      : frameAt(timestamps, time);
  const setTimestampIndex = useCallback(
    (index: number) => {
      if (!onTimeChange) {
        setOwnIndex(index);
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
  const [planIndex, choosePlan] = usePlanChoice(plans);
  const activePlan = plans?.[planIndex] ?? null;
  const location = useMemo(() => planLocation(baseLocation, activePlan), [baseLocation, activePlan]);

  const image = useLageplanImage(location?.lageplan_url ? getBackendUrl(location.lageplan_url) : null);
  const imageSize = useMemo(
    () => (image ? { width: image.naturalWidth, height: image.naturalHeight } : null),
    [image],
  );

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
  const frame = useMemo(
    () =>
      layout && timestamps.length > 0
        ? chartFrame(layout, frameWeights(sensors, frameIndex, fieldMode), {
            sigma,
            heatReference: heatReference(location),
            fieldRange: fieldScale?.range ?? null,
          })
        : null,
    [layout, timestamps.length, sensors, frameIndex, fieldMode, sigma, location, fieldScale],
  );

  const colorTable = useMemo(() => heatColorTable(), []);
  const heatCanvas = useMemo(
    () => (frame ? heatFieldCanvas(frame, colorTable) : null),
    [frame, colorTable],
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
            scaleTitle: fieldScale?.unit ?? t('heatmap_heat'),
            tickLabel: (value) =>
              fieldScale ? fieldReading(fieldScale, value).toFixed(fieldScale.decimals) : value.toFixed(1),
          }
        : null,
    [layout, frame, image, heatCanvas, colorTable, fieldMode, fieldScale, t],
  );

  // ---------------------------------------------------------------- viewport

  const { wrapRef, width, canvasHeight, view, isZoomed, setView, zoomBy } = useHeatmapViewport({
    bounds: scene?.layout.bounds ?? null,
    height,
    fitPlan,
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
      setHover({ kind: 'sensor', pos: sensor.pos, screen: target.screen, meters: target.meters });
      return;
    }
    reportHoveredDevice(null);
    setHover(target ? { ...target, cursor: [sx, sy] } : null);
  };

  const clearHover = () => {
    setHover(null);
    reportHoveredDevice(null);
  };

  const { canvasRef, grabbing, handlers } = usePanZoomGestures({
    enabled: scene != null,
    view,
    setView,
    zoomBy,
    onHover: updateHover,
    onLeave: clearHover,
    onTap: (sx, sy) => {
      if (!scene || !view || !onSensorClick) {
        return;
      }
      const target = hoverTarget(scene.layout, scene.frame, view, location, imageSize, sx, sy);
      if (target?.kind === 'sensor') {
        onSensorClick(scene.layout.sensors[target.index].pos);
      }
    },
    wheelZoomsAt: (sx, sy) => Boolean(scene && view && isOverDrawn(scene.layout, view, image != null, sx, sy)),
  });

  // ---------------------------------------------------------------- drawing

  const sensorIndex = (match: (sensor: Scene['layout']['sensors'][number]) => boolean) => {
    const index = scene?.layout.sensors.findIndex(match) ?? -1;
    return index >= 0 ? index : null;
  };
  const hoveredIndex = hover?.kind === 'sensor' ? sensorIndex((sensor) => sensor.pos === hover.pos) : null;
  const highlightedIndex =
    highlightedDevice != null ? sensorIndex((sensor) => sensor.device === highlightedDevice) : null;
  // The guides only lead to a position in meters.
  const guideCursor = hover?.kind === 'cursor' && hover.meters ? hover.cursor : null;

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
        { hovered: hoveredIndex, highlighted: highlightedIndex, cursor: guideCursor },
        null,
      );
    }
  }, [canvasRef, scene, view, width, canvasHeight, hoveredIndex, highlightedIndex, guideCursor]);

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
            (alignment prop takes precedence). */}
        <HeatmapToolbar
          plans={alignment ? null : plans}
          planIndex={planIndex}
          onPlanChange={choosePlan}
          sigma={sigma}
          onSigmaChange={setSigma}
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
        <div className="mt-1 pb-1">
          <FrameSlider
            id="heatmap2d-timestamp"
            timestamps={timestamps}
            index={frameIndex}
            onChange={setTimestampIndex}
            disabled={videoExport.videoExporting}
            alarms={alarms}
          />
        </div>
      </div>

      {videoExport.videoError && (
        <div className="text-danger small mb-2 px-2">{videoExport.videoError}</div>
      )}

      <div
        ref={wrapRef}
        className="heatmap2d-plot-wrap"
        style={{ position: 'relative', height: canvasHeight }}
      >
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={t('heatmap_canvas_hint')}
          style={{
            display: 'block',
            width: '100%',
            height: canvasHeight,
            touchAction: 'none',
            cursor: hoveredIndex != null ? 'pointer' : grabbing ? 'grabbing' : 'grab',
          }}
          {...handlers}
          onDoubleClick={() => setView(null)}
        />

        <ZoomControls
          onZoomIn={() => zoomBy(ZOOM_STEP)}
          onZoomOut={() => zoomBy(1 / ZOOM_STEP)}
          onReset={() => setView(null)}
          resetDisabled={!isZoomed}
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
          />
        )}

        {hover?.kind === 'cursor' && (
          <CursorReadout meters={hover.meters} heat={hover.heat} fieldScale={fieldScale} />
        )}
      </div>
    </>
  ) : (
    <div className="text-muted py-5 text-center">{t('heatmap_no_data')}</div>
  );

  if (hideChrome) {
    return body;
  }

  return (
    <Card className="border-0 shadow-sm">
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
}: {
  sensor: ChartSensor;
  value: number;
  meters: [number, number] | null;
  screen: [number, number];
  fieldScale: FieldScale | null;
  colorTable: Uint8ClampedArray;
  containerWidth: number;
  containerHeight: number;
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
    />
  );
};

/** Position in meters and heat (field mode: the reading) under the cursor,
 * bottom left on the plan. */
const CursorReadout = ({
  meters,
  heat,
  fieldScale,
}: {
  meters: [number, number] | null;
  heat: number | null;
  fieldScale: FieldScale | null;
}) => {
  const { t } = useTranslation();
  const heatText = (value: number) =>
    fieldScale
      ? formatReading(fieldScale, fieldReading(fieldScale, value))
      : `${t('heatmap_heat')} ${value.toFixed(2)}`;
  return (
    <div
      className="small"
      style={{
        position: 'absolute',
        left: 8,
        bottom: 8,
        padding: '2px 8px',
        borderRadius: 6,
        background: 'rgba(255, 255, 255, 0.85)',
        color: plotTheme.brandBlue,
        pointerEvents: 'none',
      }}
    >
      {[meters ? formatMeters(meters) : null, heat == null ? null : heatText(heat)]
        .filter(Boolean)
        .join(' · ')}
    </div>
  );
};

export default SensorHeatmap2D;
