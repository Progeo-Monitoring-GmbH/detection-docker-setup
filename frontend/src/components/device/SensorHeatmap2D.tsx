import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Button, ButtonGroup, Card, Form, Spinner } from 'react-bootstrap';
import { ArrowCounterclockwise, Film, ZoomIn, ZoomOut } from 'react-bootstrap-icons';
import { plotTheme } from '../../styles/plotTheme';
import FrameSlider, { type AlarmSpan } from './FrameSlider';
import {
  buildFieldGrid,
  buildWeightedGrid,
  seriesRange,
  type WeightedPoint,
} from './heatmapGrid';
import {
  containsPoint,
  fitView,
  heatAt,
  heatColorAt,
  heatColorTable,
  heatPixels,
  heatRect,
  MAX_ZOOM,
  MIN_ZOOM,
  nearestPoint,
  panBy,
  plotToWorld,
  toScreen,
  toWorld,
  type View,
  WORLD_FALLBACK,
  type WorldRect,
  type WorldSize,
  zoomAt,
} from './heatmapCanvas';
import {
  formatMeters,
  isCalibrated,
  pixelToMeters,
  pointMeters,
} from './planMeters';
import SensorTooltip from './SensorTooltip';
import type { SensorHeatmapLocation, SensorHeatmapResponse } from './sensorHeatmapTypes';
import { useHeatmapFrameExport } from './useHeatmapFrameExport';
import { useAuth } from '../../../hooks/CoreAuthProvider';
import axiosConfig from '../../axiosConfig';
import { getBackendUrl } from '../../backendUrl';
import { alignmentBaseScale } from '../ui/ImageCanvasStage';

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
};

type ImageSize = {
  width: number;
  height: number;
};

type HoveredSensor = {
  pos: number;
  meters: [number, number] | null;
  value: number;
  cursorX: number;
  cursorY: number;
};

/** What the cursor points at outside a sensor: meters + heat, and the
 * reference point's guides (screen pixels). */
type CursorInfo = {
  meters: [number, number] | null;
  heat: number | null;
  cursor: [number, number];
};

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

/**
 * Auto bandwidth: use the median nearest-neighbour distance so that
 * neighbouring sensors merge into one hot region while isolated sensors
 * keep a reasonably tight kernel ("points attract each other").
 */
const computeAutoSigma = (points: Array<{ x: number; y: number }>) => {
  if (points.length < 2) {
    return 0.05;
  }

  const nearest: number[] = [];
  points.forEach((point, index) => {
    let best = Number.POSITIVE_INFINITY;
    points.forEach((other, otherIndex) => {
      if (otherIndex === index) {
        return;
      }
      best = Math.min(best, Math.hypot(point.x - other.x, point.y - other.y));
    });
    if (Number.isFinite(best)) {
      nearest.push(best);
    }
  });

  if (!nearest.length) {
    return 0.05;
  }

  nearest.sort((a, b) => a - b);
  const median = nearest[Math.floor(nearest.length / 2)];
  return clamp(median * 1.15, 0.008, 0.12);
};

/**
 * Multiplier applied to the location's alarm threshold to define the heat
 * value at which the field saturates (heat = 1). Sensors must read well
 * above the alarm threshold before the heatmap turns fully "hot".
 */
const HEAT_FULL_MULTIPLIER = 3;

/**
 * Width of the heat field's border around the outermost sensors, in sigmas of
 * the automatic kernel width (from the sensor spacing) - at 3 sigma a kernel
 * has faded to ~1%. Deliberately independent of a manually chosen sigma, so
 * changing the kernel width doesn't change the map's margin.
 */
const HEAT_BORDER_SIGMAS = 3;

/** Opacity of the heat field over the plan. */
const HEAT_OPACITY = 0.7;
/** Space kept free on the right of the initial view for the colour scale. */
const COLORBAR_SPACE = 58;
/** Hover radius around a sensor marker (screen pixels). */
const SENSOR_HIT_RADIUS = 11;
const ZOOM_STEP = 1.4;
const MARKER_RADIUS = 4.5;
/** Marker of a sensor reading above its threshold. */
const OVER_THRESHOLD_COLOR = '#dc2626';
/** fitPlan: the tallest canvas, relative to its width (very tall plans). */
const FIT_PLAN_MAX_ASPECT = 2;

type Chart = {
  world: WorldSize;
  grid: Float64Array[];
  xAxis: number[];
  yAxis: number[];
  heatRect: WorldRect;
  /** The initial view: sensors, their heat border and the reference point. */
  bounds: WorldRect;
  sensors: Array<{
    pos: number;
    wx: number;
    wy: number;
    nx: number | null;
    ny: number | null;
    value: number;
    /** The sensor's own threshold, else the location's; null without one. */
    threshold: number | null;
    name: string | null;
    /** Field mode: the device and its name in the climate charts. */
    device: number | null;
    label: string | null;
  }>;
  reference: [number, number] | null;
  /** Field mode: opacity per grid cell (0 away from the sensors). */
  coverage: Float64Array[] | null;
};

/**
 * Sensor heatmap on the Lageplan as a canvas: the plan image in the
 * background, the Gaussian heat field (buildWeightedGrid) on top, sensor
 * markers, the reference point and a colour scale. Zoom with the mouse wheel
 * (around the cursor) or the buttons, drag to move, pinch on touch devices,
 * double-click to reset. Hovering a sensor shows its tooltip, anywhere else
 * on the plan the position in meters (with the dotted guides from the
 * reference point) and the heat there. The video export draws its frames
 * from the same scene (renderFrame).
 */
const SensorHeatmap2D = ({
  response,
  height = 800,
  resolution = 180,
  alignment = null,
  hideChrome = false,
  onTimestampChange,
  alarms,
  field,
  fitPlan = false,
  highlightedDevice = null,
  onHoverDevice,
}: SensorHeatmap2DProps) => {
  const { t } = useTranslation();
  // Primitives, so a new `field` object per render doesn't recompute.
  const fieldUnit = field?.unit ?? null;
  const fieldDecimals = field?.decimals ?? 1;
  const [timestampIndex, setTimestampIndex] = useState(0);
  const [sigma, setSigma] = useState<'auto' | number>('auto');
  const [imageSize, setImageSize] = useState<ImageSize | null>(null);
  // The loaded lageplan, see the loading effect below.
  const [lageplanImage, setLageplanImage] = useState<HTMLImageElement | null>(null);
  const [hoveredSensor, setHoveredSensor] = useState<HoveredSensor | null>(null);
  const [cursorInfo, setCursorInfo] = useState<CursorInfo | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const timestamps = useMemo(
    () => (Array.isArray(response?.timestamps) ? response.timestamps : []),
    [response],
  );

  useEffect(() => {
    setTimestampIndex((current) =>
      Math.max(0, Math.min(current, Math.max(timestamps.length - 1, 0))),
    );
  }, [timestamps.length]);

  useEffect(() => {
    onTimestampChange?.(timestampIndex);
  }, [onTimestampChange, timestampIndex]);

  /** Alignment from the view (with_sliders mode) takes precedence over the list. */
  const baseLocation = useMemo(
    () => alignment ?? response?.location ?? null,
    [alignment, response],
  );

  /** All lageplans of the location (may be several - user can swap between them). */
  const plans = useMemo(() => {
    const list = baseLocation?.lageplans;
    return Array.isArray(list) && list.length > 0 ? list : null;
  }, [baseLocation]);

  const [planIndex, setPlanIndex] = useState(0);
  useEffect(() => {
    setPlanIndex(0);
  }, [plans]);

  const activePlan = plans
    ? (plans[Math.min(planIndex, plans.length - 1)] ?? null)
    : null;

  /**
   * Effective location: merge the selected lageplan's url + alignment into the
   * location payload so the existing rendering code keeps working unchanged.
   */
  const location = useMemo(() => {
    if (!activePlan) {
      return baseLocation;
    }
    return {
      ...baseLocation,
      lageplan_url: activePlan.url ?? null,
      offset_x: activePlan.offset_x ?? 0,
      offset_y: activePlan.offset_y ?? 0,
      scale_x: activePlan.scale_x ?? 1,
      scale_y: activePlan.scale_y ?? 1,
      flip_x: Boolean(activePlan.flip_x),
      flip_y: Boolean(activePlan.flip_y),
      reference_x: activePlan.reference_x ?? null,
      reference_y: activePlan.reference_y ?? null,
      meters_per_pixel: activePlan.meters_per_pixel ?? null,
    };
  }, [baseLocation, activePlan]);

  const lageplanUrl = useMemo(() => {
    const raw = location?.lageplan_url;

    return raw ? getBackendUrl(raw) : null;
  }, [location]);

  const auth = useAuth();
  const authRef = useRef(auth);
  authRef.current = auth;

  // Load the lageplan once per plan - with the Authorization header (media
  // is authenticated) - and keep the decoded image for drawing.
  useEffect(() => {
    setLageplanImage(null);
    setImageSize(null);
    if (!lageplanUrl) {
      return undefined;
    }

    let cancelled = false;
    void axiosConfig.perform_get(
      authRef.current,
      lageplanUrl,
      (response) => {
        const reader = new FileReader();
        reader.onload = () => {
          if (cancelled || typeof reader.result !== 'string') {
            return;
          }
          const image = new Image();
          image.onload = () => {
            if (!cancelled) {
              setImageSize({
                width: image.naturalWidth,
                height: image.naturalHeight,
              });
              setLageplanImage(image);
            }
          };
          image.src = reader.result;
        };
        reader.readAsDataURL(response.data as Blob);
      },
      () => {
        // No plan image - the heatmap is still shown without it.
      },
      { responseType: 'blob' },
    );

    return () => {
      cancelled = true;
    };
  }, [lageplanUrl]);

  /**
   * Sensors are placed at their normalized (nx, ny) positions. The whole
   * codebase treats ny = 0 as the top of the lageplan, so the plot y
   * coordinate is mirrored: v = 1 - ny.
   */
  const sensors = useMemo(() => {
    const data = response?.data || {};
    const sensorPoints = response?.sensor_points || [];
    const isFlippedY = Boolean(location?.flip_y);

    const positioned = sensorPoints
      .map((point) => ({
        pos: point.pos,
        // Raw normalized position, for the position in meters.
        nx: Number(point.x) as number | null,
        ny: Number(point.y) as number | null,
        x: Number(point.x),
        // ny = 0 is the top of the plan (as in the alignment wizard); a
        // vertically flipped plan uses ny as-is.
        y: isFlippedY ? Number(point.y) : 1 - Number(point.y),
        series: Array.isArray(data[String(point.pos)])
          ? data[String(point.pos)]
          : [],
        threshold: point.threshold != null && Number.isFinite(Number(point.threshold))
          ? Number(point.threshold)
          : null,
        name: point.name ?? null,
        device: point.device ?? null,
        label: point.label ?? null,
      }))
      .filter((entry) => Number.isFinite(entry.x) && Number.isFinite(entry.y));

    if (positioned.length) {
      return positioned;
    }

    // Fallback: lay out sensors that have data on a regular grid by key order.
    const keys = Object.keys(data).sort((a, b) => Number(a) - Number(b));
    const count = keys.length;
    const columns = Math.max(Math.ceil(Math.sqrt(count)), 1);
    const rows = Math.max(Math.ceil(count / columns), 1);
    return keys.map((key, index) => ({
      pos: Number(key) || index + 1,
      // Not on the plan - no position in meters.
      nx: null,
      ny: null,
      x: (index % columns) / Math.max(columns - 1, 1),
      y: 1 - Math.floor(index / columns) / Math.max(rows - 1, 1),
      series: data[key] || [],
      threshold: null as number | null,
      name: null as string | null,
      device: null as number | null,
      label: null as string | null,
    }));
  }, [response, location]);

  const weightedPoints = useMemo<WeightedPoint[]>(() => {
    if (!sensors.length || !timestamps.length) {
      return [];
    }

    // Heat of the selected timestamp. In field mode the reading itself
    // (temperatures can be negative), NaN without one - left out.
    return sensors.map((sensor) => {
      const value = sensor.series[timestampIndex];
      const missing = value == null || !Number.isFinite(Number(value));
      const weight =
        fieldUnit != null
        ? missing
          ? Number.NaN
          : Number(value)
        : missing
          ? 0
          : Math.abs(Number(value));

      return {
        pos: sensor.pos,
        x: sensor.x,
        y: sensor.y,
        weight,
      };
    });
  }, [sensors, timestamps.length, timestampIndex, fieldUnit]);

  // Field mode: one colour scale for every frame, so the frames compare.
  const fieldRange = useMemo(
    () =>
      fieldUnit != null
        ? (seriesRange(
            sensors.map((sensor) => sensor.series),
            10 ** (1 - fieldDecimals),
          ) ?? { min: 0, max: 1 })
        : null,
    [fieldUnit, fieldDecimals, sensors],
  );

  const chart = useMemo<Chart | null>(() => {
    if (!timestamps.length || !sensors.length) {
      return null;
    }

    const autoSigma = computeAutoSigma(sensors);
    const usedSigma = sigma === 'auto' ? autoSigma : clamp(sigma, 0.005, 0.3);

    // Heat normalization: the field saturates (heat = 1) only when sensor
    // values reach HEAT_FULL_MULTIPLIER times the location's alarm threshold.
    // Without a usable threshold the field falls back to relative scaling.
    const rawThreshold = Number(location?.alarm_threshold);
    const heatReference =
      Number.isFinite(rawThreshold) && rawThreshold > 0
        ? rawThreshold * HEAT_FULL_MULTIPLIER
        : null;

    // Lageplan alignment: the alignment wizard maps normalized coordinates to
    // canvas pixels via  pixel = offset + coord * drawnImageSize * scale. The
    // plot space spans the image as [0, 1] x [0, 1]; the sensor coordinates
    // are scaled by scale_x/scale_y (plus the offsets) so the points land
    // exactly where the wizard placed them on the plan.
    const rawScaleX = Number(location?.scale_x ?? 1);
    const rawScaleY = Number(location?.scale_y ?? 1);
    const rawOffsetX = Number(location?.offset_x ?? 0);
    const rawOffsetY = Number(location?.offset_y ?? 0);
    const scaleX = Number.isFinite(rawScaleX) && rawScaleX > 0 ? rawScaleX : 1;
    const scaleY = Number.isFinite(rawScaleY) && rawScaleY > 0 ? rawScaleY : 1;
    const offsetX = Number.isFinite(rawOffsetX) ? rawOffsetX : 0;
    const offsetY = Number.isFinite(rawOffsetY) ? rawOffsetY : 0;

    // Offsets are canvas pixels of the alignment wizard (ImageCanvasStage),
    // where the plan is drawn at alignmentBaseScale - so they are normalized
    // by the image size at that scale. They only apply once the image has
    // actually loaded, and degrade gracefully before that.
    const sizeKnown = Boolean(lageplanImage && imageSize);
    const imgWidth = imageSize?.width ?? 1;
    const imgHeight = imageSize?.height ?? 1;
    const wizardScale = sizeKnown ? alignmentBaseScale(imgWidth, imgHeight) : 1;
    const offsetNormX = sizeKnown ? offsetX / (imgWidth * wizardScale) : 0;
    const offsetNormY = sizeKnown ? offsetY / (imgHeight * wizardScale) : 0;

    // sensors.x/y follow the mirrored convention (y = 1 - ny, or raw ny when
    // the lageplan is flipped), so the plot y transform collapses to:
    //   plotY = yUser * scaleY + (1 - scaleY) - offsetNormY
    const toPlotX = (xUser: number) => offsetNormX + xUser * scaleX;
    const toPlotY = (yUser: number) =>
      yUser * scaleY + (1 - scaleY) - offsetNormY;

    // World = pixels of the plan image (without one: a stand-in square).
    const world: WorldSize = sizeKnown
      ? { width: imgWidth, height: imgHeight }
      : { width: WORLD_FALLBACK, height: WORLD_FALLBACK };

    // The heat field is computed in normalized space (isotropic kernels) and
    // stretched onto the scaled plot domain, so heat extends exactly as far
    // as the scaled sensor positions.
    const { axis, grid, coverage } = fieldRange
      ? buildFieldGrid(
          weightedPoints,
          resolution,
          usedSigma,
          fieldRange,
          HEAT_BORDER_SIGMAS * autoSigma,
        )
      : {
          ...buildWeightedGrid(
            weightedPoints,
            resolution,
            usedSigma,
            heatReference,
            HEAT_BORDER_SIGMAS * autoSigma,
          ),
          coverage: null,
        };
    const xAxis = axis.map((value) => toPlotX(value));
    const yAxis = axis.map((value) => toPlotY(value));
    const field = heatRect(xAxis, yAxis, world);

    const locationThreshold = Number.isFinite(rawThreshold) && rawThreshold > 0 ? rawThreshold : null;
    const placed = sensors.map((sensor, index) => {
      const [wx, wy] = plotToWorld(toPlotX(sensor.x), toPlotY(sensor.y), world);
      return {
        pos: sensor.pos,
        wx,
        wy,
        nx: sensor.nx,
        ny: sensor.ny,
        value: weightedPoints[index]?.weight ?? 0,
        // Thresholds are alarm levels of the summed heat, not of a field.
        threshold: fieldRange ? null : (sensor.threshold ?? locationThreshold),
        name: sensor.name,
        device: sensor.device,
        label: sensor.label,
      };
    });

    // Reference point of the positions in meters (image pixels).
    const reference: [number, number] | null =
      sizeKnown && isCalibrated(location)
        ? [location?.reference_x as number, location?.reference_y as number]
        : null;

    // The initial view is cropped to the sensors, their heat border and the
    // reference point (plus a small margin) - the rest of the plan is mostly
    // empty paper. fitPlan: the whole plan (and any sensor beside it), the
    // heat border may run off the edge.
    const fitWholePlan = fitPlan && sizeKnown;
    const extent = fitWholePlan
      ? { xs: [0, world.width], ys: [0, world.height] }
      : { xs: [field.left, field.right], ys: [field.top, field.bottom] };
    const xs = [...extent.xs, ...placed.map((s) => s.wx), ...(reference ? [reference[0]] : [])];
    const ys = [...extent.ys, ...placed.map((s) => s.wy), ...(reference ? [reference[1]] : [])];
    const margin = (fitWholePlan ? 0.005 : 0.02) * Math.max(world.width, world.height);
    const bounds: WorldRect = {
      left: Math.min(...xs) - margin,
      right: Math.max(...xs) + margin,
      top: Math.min(...ys) - margin,
      bottom: Math.max(...ys) + margin,
    };

    return {
      world,
      grid,
      xAxis,
      yAxis,
      heatRect: field,
      bounds,
      sensors: placed,
      reference,
      coverage,
    };
  }, [
    sensors,
    weightedPoints,
    timestamps.length,
    sigma,
    resolution,
    location,
    lageplanImage,
    imageSize,
    fieldRange,
    fitPlan,
  ]);

  // The heat field as an image (one pixel per grid cell), smoothed when drawn.
  const colorTable = useMemo(() => heatColorTable(), []);
  const heatCanvas = useMemo(() => {
    if (!chart || typeof document === 'undefined') {
      return null;
    }
    const size = chart.grid.length;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx || !size) {
      return null;
    }
    const image = ctx.createImageData(size, size);
    image.data.set(heatPixels(chart.grid, colorTable, chart.coverage ?? undefined));
    ctx.putImageData(image, 0, 0);
    return canvas;
  }, [chart, colorTable]);

  // ---------------------------------------------------------------- viewport

  const [wrapSize, setWrapSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) {
      return undefined;
    }
    const measure = () => {
      setWrapSize({ width: wrap.clientWidth, height: wrap.clientHeight });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [chart != null]);

  // Fit the canvas height to the content: the view keeps the plan's aspect
  // ratio, so a fixed height would leave empty bands above/below a wide
  // plan. `height` is the upper bound - with fitPlan the full width counts
  // instead (up to FIT_PLAN_MAX_ASPECT), so a tall plan doesn't leave empty
  // bands beside it.
  const canvasHeight = useMemo(() => {
    if (!chart || wrapSize.width <= 0) {
      return height;
    }
    const spanX = chart.bounds.right - chart.bounds.left;
    const spanY = chart.bounds.bottom - chart.bounds.top;
    const usable = wrapSize.width - COLORBAR_SPACE;
    if (spanX <= 0 || spanY <= 0 || usable <= 0) {
      return height;
    }
    const maxHeight = fitPlan ? Math.max(height, usable * FIT_PLAN_MAX_ASPECT) : height;
    return Math.round(clamp((usable * spanY) / spanX, 160, maxHeight));
  }, [chart, wrapSize.width, height, fitPlan]);

  const canvasWidth = wrapSize.width;
  const fitted = useMemo(
    () =>
      chart && canvasWidth > 0
        ? fitView(chart.bounds, canvasWidth, canvasHeight, COLORBAR_SPACE)
        : null,
    [chart?.bounds.left, chart?.bounds.top, chart?.bounds.right, chart?.bounds.bottom, canvasWidth, canvasHeight],
  );

  // The user's zoom/pan; null = the fitted view. A new plan, other sensors or
  // a resize while fitted start from the fitted view again.
  const [userView, setUserView] = useState<View | null>(null);
  const boundsKey = chart
    ? `${chart.bounds.left}:${chart.bounds.top}:${chart.bounds.right}:${chart.bounds.bottom}`
    : '';
  useEffect(() => {
    setUserView(null);
  }, [boundsKey]);

  const view = userView ?? fitted;
  const minScale = (fitted?.scale ?? 1) * MIN_ZOOM;
  const maxScale = (fitted?.scale ?? 1) * MAX_ZOOM;

  const zoomBy = useCallback(
    (factor: number, sx?: number, sy?: number) => {
      if (!view) {
        return;
      }
      setUserView(
        zoomAt(view, factor, sx ?? canvasWidth / 2, sy ?? canvasHeight / 2, minScale, maxScale),
      );
    },
    [view, canvasWidth, canvasHeight, minScale, maxScale],
  );

  // ---------------------------------------------------------------- drawing

  const threshold = Number.isFinite(Number(location?.alarm_threshold))
    ? Number(location?.alarm_threshold)
    : null;

  /** Field mode: the reading a grid value (0..1 of the scale) stands for. */
  const fieldValue = useCallback(
    (heat: number) =>
      fieldRange ? fieldRange.min + heat * (fieldRange.max - fieldRange.min) : heat,
    [fieldRange],
  );
  /** Field mode: a reading with its unit, e.g. "54.3 %". */
  const formatField = useCallback(
    (value: number) => `${value.toFixed(fieldDecimals)} ${fieldUnit ?? ''}`.trim(),
    [fieldDecimals, fieldUnit],
  );

  /** Draws the whole scene for `drawView` onto ctx (css pixels x dpr). */
  const drawScene = useCallback(
    (
      ctx: CanvasRenderingContext2D,
      width: number,
      height: number,
      dpr: number,
      drawView: View,
      overlay: {
        hovered: number | null;
        /** Sensor index highlighted from outside (highlightedDevice). */
        highlighted: number | null;
        cursor: [number, number] | null;
      },
      background: string | null,
    ) => {
      if (!chart) {
        return;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (background) {
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, width, height);
      } else {
        ctx.clearRect(0, 0, width, height);
      }

      // World layer: plan + heat field, zoomed and moved.
      ctx.save();
      ctx.setTransform(
        dpr * drawView.scale,
        0,
        0,
        dpr * drawView.scale,
        dpr * drawView.tx,
        dpr * drawView.ty,
      );
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      if (lageplanImage) {
        ctx.drawImage(lageplanImage, 0, 0, chart.world.width, chart.world.height);
      }
      if (heatCanvas) {
        const field = chart.heatRect;
        ctx.globalAlpha = HEAT_OPACITY;
        ctx.drawImage(heatCanvas, field.left, field.top, field.right - field.left, field.bottom - field.top);
        ctx.globalAlpha = 1;
      }
      ctx.restore();

      // Screen layer: markers keep their size at any zoom.
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const reference = chart.reference ? toScreen(drawView, chart.reference[0], chart.reference[1]) : null;

      if (reference && overlay.cursor) {
        const [cx, cy] = overlay.cursor;
        ctx.save();
        ctx.strokeStyle = plotTheme.green;
        ctx.lineWidth = 2;
        ctx.lineCap = 'round';
        ctx.setLineDash([2, 4]);
        ctx.beginPath();
        ctx.moveTo(reference[0], reference[1]);
        ctx.lineTo(cx, reference[1]);
        ctx.lineTo(cx, cy);
        ctx.stroke();
        ctx.restore();
      }

      if (reference) {
        ctx.save();
        ctx.strokeStyle = plotTheme.green;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(reference[0], reference[1], 8, 0, Math.PI * 2);
        ctx.moveTo(reference[0] - 8, reference[1]);
        ctx.lineTo(reference[0] + 8, reference[1]);
        ctx.moveTo(reference[0], reference[1] - 8);
        ctx.lineTo(reference[0], reference[1] + 8);
        ctx.stroke();
        ctx.restore();
      }

      ctx.save();
      ctx.font = '600 10px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      // The highlighted sensor last - on top of its neighbours' labels.
      const order = chart.sensors.map((_, index) => index);
      if (overlay.highlighted != null) {
        order.push(...order.splice(overlay.highlighted, 1));
      }
      order.forEach((index) => {
        const sensor = chart.sensors[index];
        const [sx, sy] = toScreen(drawView, sensor.wx, sensor.wy);
        if (sx < -20 || sy < -20 || sx > width + 20 || sy > height + 20) {
          return;
        }
        const highlighted = overlay.highlighted === index;
        if (highlighted) {
          ctx.beginPath();
          ctx.arc(sx, sy, MARKER_RADIUS + 7, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
          ctx.fill();
          ctx.strokeStyle = plotTheme.brandOrange;
          ctx.lineWidth = 3;
          ctx.stroke();
        } else if (overlay.hovered === index) {
          ctx.beginPath();
          ctx.arc(sx, sy, MARKER_RADIUS + 4, 0, Math.PI * 2);
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 2;
          ctx.stroke();
        }
        const over = sensor.threshold != null && sensor.value > sensor.threshold;
        ctx.beginPath();
        ctx.arc(sx, sy, over ? MARKER_RADIUS + 1 : MARKER_RADIUS, 0, Math.PI * 2);
        ctx.fillStyle = over ? OVER_THRESHOLD_COLOR : plotTheme.brandBlue;
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1;
        ctx.stroke();
        // Field mode: the sensors are devices - named like their lines in
        // the climate charts; otherwise the sensor number.
        const text = fieldUnit != null ? (sensor.label ?? sensor.name ?? String(sensor.pos)) : String(sensor.pos);
        const textY = sy - MARKER_RADIUS - (highlighted ? 7 : 2);
        ctx.font = highlighted ? '700 12px system-ui, sans-serif' : '600 10px system-ui, sans-serif';
        // Readable on the plan and on the heat: white with a dark outline.
        ctx.lineWidth = 3;
        ctx.strokeStyle = highlighted ? plotTheme.brandOrange : 'rgba(9, 75, 129, 0.85)';
        ctx.strokeText(text, sx, textY);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(text, sx, textY);
      });
      ctx.restore();

      // Colour scale on the right (part of every frame of the video export).
      const barTop = 22;
      const barBottom = Math.max(barTop + 40, Math.min(height - 12, barTop + 220));
      const barX = width - 44;
      ctx.save();
      ctx.fillStyle = 'rgba(255, 255, 255, 0.82)';
      ctx.fillRect(barX - 6, barTop - 16, 50, barBottom - barTop + 26);
      const gradient = ctx.createLinearGradient(0, barBottom, 0, barTop);
      for (let index = 0; index <= 10; index += 1) {
        const color = Math.round((index / 10) * 255) * 3;
        gradient.addColorStop(
          index / 10,
          `rgb(${colorTable[color]}, ${colorTable[color + 1]}, ${colorTable[color + 2]})`,
        );
      }
      ctx.fillStyle = gradient;
      ctx.fillRect(barX, barTop, 10, barBottom - barTop);
      ctx.fillStyle = plotTheme.brandBlue;
      ctx.font = '600 10px system-ui, sans-serif';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(fieldUnit ?? t('heatmap_heat'), barX - 2, barTop - 5);
      ctx.font = '10px system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      for (let tick = 0; tick <= 5; tick += 1) {
        const value = tick / 5;
        const y = barBottom - value * (barBottom - barTop);
        ctx.fillRect(barX + 10, y - 0.5, 3, 1);
        ctx.fillText(
          fieldRange ? fieldValue(value).toFixed(fieldDecimals) : value.toFixed(1),
          barX + 15,
          y,
        );
      }
      ctx.restore();
    },
    [chart, lageplanImage, heatCanvas, colorTable, t, fieldUnit, fieldRange, fieldValue, fieldDecimals],
  );

  const hoveredIndex = hoveredSensor
    ? (chart?.sensors.findIndex((sensor) => sensor.pos === hoveredSensor.pos) ?? -1)
    : -1;
  const highlightedIndex =
    highlightedDevice != null
      ? (chart?.sensors.findIndex((sensor) => sensor.device === highlightedDevice) ?? -1)
      : -1;

  // Redraw on every change; the export waits for the new timestamp's frame.
  const afterDrawRef = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !chart || !view || canvasWidth <= 0) {
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    const backingWidth = Math.round(canvasWidth * dpr);
    const backingHeight = Math.round(canvasHeight * dpr);
    if (canvas.width !== backingWidth || canvas.height !== backingHeight) {
      canvas.width = backingWidth;
      canvas.height = backingHeight;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }
    drawScene(
      ctx,
      canvasWidth,
      canvasHeight,
      dpr,
      view,
      {
        hovered: hoveredIndex >= 0 ? hoveredIndex : null,
        highlighted: highlightedIndex >= 0 ? highlightedIndex : null,
        // The guides only lead to a position in meters.
        cursor: cursorInfo?.meters ? cursorInfo.cursor : null,
      },
      null,
    );
  }, [drawScene, chart, view, canvasWidth, canvasHeight, hoveredIndex, highlightedIndex, cursorInfo]);

  useEffect(() => {
    afterDrawRef.current?.();
  }, [chart]);

  // ---------------------------------------------------------------- export

  /** One video frame: the current view, scaled to width x height. */
  const renderFrame = useCallback(
    (width: number, height: number) => {
      if (!chart || !view || canvasWidth <= 0) {
        return null;
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        return null;
      }
      const factor = Math.min(width / canvasWidth, height / canvasHeight);
      const frameView: View = {
        scale: view.scale * factor,
        tx: view.tx * factor + (width - canvasWidth * factor) / 2,
        ty: view.ty * factor + (height - canvasHeight * factor) / 2,
      };
      drawScene(ctx, width, height, 1, frameView, { hovered: null, highlighted: null, cursor: null }, '#ffffff');
      return canvas;
    },
    [chart, view, canvasWidth, canvasHeight, drawScene],
  );

  // The export loop keeps the function it started with: it must still draw
  // the timestamp the slider shows now, so it goes through a ref.
  const renderFrameRef = useRef(renderFrame);
  renderFrameRef.current = renderFrame;
  const captureFrame = useCallback(
    (width: number, height: number) => renderFrameRef.current(width, height),
    [],
  );

  const frameSize = useCallback(
    () => (canvasWidth > 0 ? { width: canvasWidth, height: canvasHeight } : null),
    [canvasWidth, canvasHeight],
  );

  const {
    videoExporting,
    videoStage,
    videoResultUrl,
    downloadVideoResult,
    videoProgress,
    videoError,
    handleAfterPlot,
    exportFrames,
  } = useHeatmapFrameExport({
    captureFrame,
    frameSize,
    chartReady: chart != null,
    timestamps,
    timestampIndex,
    setTimestampIndex,
  });
  afterDrawRef.current = handleAfterPlot;

  // ---------------------------------------------------------------- input

  // Active pointers (mouse, pen, fingers) for dragging and pinching.
  const pointers = useRef(new Map<number, [number, number]>());
  const dragged = useRef(false);

  const localPoint = (event: { clientX: number; clientY: number }): [number, number] => {
    const rect = canvasRef.current?.getBoundingClientRect();
    return rect ? [event.clientX - rect.left, event.clientY - rect.top] : [0, 0];
  };

  // The device last reported to onHoverDevice - pointer moves report changes only.
  const reportedDevice = useRef<number | null>(null);
  const reportHoveredDevice = (device: number | null) => {
    if (reportedDevice.current !== device) {
      reportedDevice.current = device;
      onHoverDevice?.(device);
    }
  };

  const updateHover = (sx: number, sy: number) => {
    if (!chart || !view) {
      return;
    }
    const screenPoints = chart.sensors.map((sensor) => toScreen(view, sensor.wx, sensor.wy));
    const index = nearestPoint(screenPoints, sx, sy, SENSOR_HIT_RADIUS);
    reportHoveredDevice(index != null ? chart.sensors[index].device : null);
    if (index != null) {
      const sensor = chart.sensors[index];
      setHoveredSensor({
        pos: sensor.pos,
        meters:
          sensor.nx != null && sensor.ny != null
            ? pointMeters(sensor.nx, sensor.ny, location, imageSize)
            : null,
        value: sensor.value,
        cursorX: screenPoints[index][0],
        cursorY: screenPoints[index][1],
      });
      setCursorInfo(null);
      return;
    }
    setHoveredSensor(null);
    const [wx, wy] = toWorld(view, sx, sy);
    const insidePlan = wx >= 0 && wy >= 0 && wx <= chart.world.width && wy <= chart.world.height;
    // A field has no value where it fades out (away from the sensors).
    const covered = chart.coverage
      ? (heatAt(chart.coverage, chart.xAxis, chart.yAxis, wx, wy, chart.world) ?? 0) > 0
      : true;
    const heat = covered
      ? heatAt(chart.grid, chart.xAxis, chart.yAxis, wx, wy, chart.world)
      : null;
    const meters = chart.reference && insidePlan ? pixelToMeters(wx, wy, location) : null;
    setCursorInfo(
      meters || heat != null
        ? { meters, heat, cursor: [sx, sy] }
        : null,
    );
  };

  const clearHover = () => {
    setHoveredSensor(null);
    setCursorInfo(null);
    reportHoveredDevice(null);
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, localPoint(event));
    dragged.current = false;
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const point = localPoint(event);
    const previous = pointers.current.get(event.pointerId);
    if (!previous) {
      updateHover(point[0], point[1]);
      return;
    }
    if (!view) {
      return;
    }
    if (pointers.current.size >= 2) {
      // Pinch: zoom by the change of the finger distance, around their middle.
      const [other] = [...pointers.current.entries()].filter(([id]) => id !== event.pointerId);
      const [, otherPoint] = other;
      const before = Math.hypot(previous[0] - otherPoint[0], previous[1] - otherPoint[1]);
      const after = Math.hypot(point[0] - otherPoint[0], point[1] - otherPoint[1]);
      pointers.current.set(event.pointerId, point);
      if (before > 0) {
        zoomBy(after / before, (point[0] + otherPoint[0]) / 2, (point[1] + otherPoint[1]) / 2);
      }
      dragged.current = true;
      return;
    }
    const dx = point[0] - previous[0];
    const dy = point[1] - previous[1];
    if (!dragged.current && Math.hypot(dx, dy) < 3) {
      return;
    }
    dragged.current = true;
    pointers.current.set(event.pointerId, point);
    clearHover();
    setUserView(panBy(view, dx, dy));
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    pointers.current.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  // The wheel zooms around the cursor - but only over the drawn plan (without
  // a plan: the heat field); everywhere else it scrolls the page as usual -
  // the heat field reaches far beyond the plan and would catch it. While
  // zooming it must not scroll the page (React's wheel listener is passive,
  // hence addEventListener).
  const zoomByRef = useRef(zoomBy);
  zoomByRef.current = zoomBy;
  const overDrawnRef = useRef<(sx: number, sy: number) => boolean>(() => false);
  overDrawnRef.current = (sx, sy) => {
    if (!chart || !view) {
      return false;
    }
    const drawn = lageplanImage
      ? { left: 0, top: 0, right: chart.world.width, bottom: chart.world.height }
      : chart.heatRect;
    const [wx, wy] = toWorld(view, sx, sy);
    return containsPoint(drawn, wx, wy);
  };
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return undefined;
    }
    const onWheel = (event: WheelEvent) => {
      const rect = canvas.getBoundingClientRect();
      const sx = event.clientX - rect.left;
      const sy = event.clientY - rect.top;
      if (!overDrawnRef.current(sx, sy)) {
        return; // the page scrolls
      }
      event.preventDefault();
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      zoomByRef.current(Math.exp(-delta * 0.0015), sx, sy);
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [chart != null]);

  const planSelectValue = plans ? Math.min(planIndex, plans.length - 1) : 0;

  const body = (
    <>
      {chart && (
        <div className="px-2 pt-2">
          {/* One compact toolbar row (wraps on narrow cards). The Lageplan
              switcher is hidden in the alignment wizard mode (alignment prop
              takes precedence). */}
          <div className="d-flex flex-wrap align-items-center gap-2">
            {!alignment && plans && plans.length > 1 && (
              <Form.Select
                size="sm"
                aria-label="Select lageplan"
                title={`Lageplan ${planSelectValue + 1} / ${plans.length}`}
                value={planSelectValue}
                onChange={(event) => setPlanIndex(Number(event.target.value))}
                style={{ width: 'auto', maxWidth: 200 }}
              >
                {plans.map((plan, index) => (
                  <option key={plan.id ?? index} value={index}>
                    {plan.name || `Lageplan ${index + 1}`}
                    {plan.is_active ? ' (aktiv)' : ''}
                  </option>
                ))}
              </Form.Select>
            )}

            {/* The kernel width sits with the export: both shape the video. */}
            <div className="ms-auto d-flex flex-wrap align-items-center justify-content-end gap-2">
              <Form.Check
                type="switch"
                id="heatmap2d-auto-sigma"
                className="small mb-0"
                label={'Auto σ'}
                checked={sigma === 'auto'}
                onChange={(event) =>
                  setSigma(event.target.checked ? 'auto' : 0.04)
                }
                disabled={videoExporting}
              />
              {sigma !== 'auto' && (
                <div className="d-flex align-items-center gap-2" style={{ width: 190 }}>
                  <label
                    htmlFor="heatmap2d-sigma"
                    className="small text-muted mb-0 text-nowrap"
                    title="σ (kernel width)"
                  >
                    {'σ'} {sigma.toFixed(3)}
                  </label>
                  <input
                    id="heatmap2d-sigma"
                    type="range"
                    className="form-range"
                    min={0.005}
                    max={0.15}
                    step={0.005}
                    value={sigma}
                    onChange={(event) => setSigma(Number(event.target.value))}
                    disabled={videoExporting}
                  />
                </div>
              )}
              {videoExporting ? (
                <>
                  <Spinner size="sm" animation="border" />
                  <span className="text-muted small">
                    {videoStage === 'capturing'
                      ? t('heatmap_video_stage_capturing', {
                          percent: Math.round((videoProgress ?? 0) * 100),
                        })
                      : videoStage === 'uploading'
                        ? t('heatmap_video_stage_uploading')
                        : videoStage === 'rendering'
                          ? t('heatmap_video_stage_rendering')
                          : t('heatmap_video_stage_downloading')}
                  </span>
                </>
              ) : (
                <>
                  {videoResultUrl && (
                    <span className="small">
                      {t('heatmap_video_ready')} -{' '}
                      <Button
                        variant="link"
                        size="sm"
                        className="p-0 align-baseline"
                        onClick={() => void downloadVideoResult()}
                      >
                        {t('heatmap_video_download')}
                      </Button>
                    </span>
                  )}
                  <Button
                    size="sm"
                    variant="outline-danger"
                    onClick={() => void exportFrames()}
                    disabled={timestamps.length < 2}
                    aria-label={t('heatmap_video_export')}
                    title={t('heatmap_video_export_title')}
                  >
                    <Film />
                  </Button>
                </>
              )}
            </div>
          </div>

          <div className="mt-1 pb-1">
            <FrameSlider
              id="heatmap2d-timestamp"
              timestamps={timestamps}
              index={timestampIndex}
              onChange={setTimestampIndex}
              disabled={videoExporting}
              alarms={alarms}
            />
          </div>
        </div>
      )}

      {!chart ? (
        <div className="text-muted py-5 text-center">{t('heatmap_no_data')}</div>
      ) : (
        <>
          {videoError && (
            <div className="text-danger small mb-2 px-2">{videoError}</div>
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
                cursor: hoveredSensor ? 'pointer' : pointers.current.size ? 'grabbing' : 'grab',
              }}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
              onPointerLeave={(event) => {
                if (!pointers.current.has(event.pointerId)) {
                  clearHover();
                }
              }}
              onDoubleClick={() => setUserView(null)}
            />

            <ButtonGroup
              size="sm"
              vertical
              style={{ position: 'absolute', left: 8, top: 8, boxShadow: '0 2px 8px rgba(11, 54, 89, .18)' }}
            >
              <Button variant="light" onClick={() => zoomBy(ZOOM_STEP)} title={t('heatmap_zoom_in')} aria-label={t('heatmap_zoom_in')}>
                <ZoomIn />
              </Button>
              <Button variant="light" onClick={() => zoomBy(1 / ZOOM_STEP)} title={t('heatmap_zoom_out')} aria-label={t('heatmap_zoom_out')}>
                <ZoomOut />
              </Button>
              <Button
                variant="light"
                onClick={() => setUserView(null)}
                disabled={userView == null}
                title={`${t('heatmap_zoom_reset')} (${t('heatmap_canvas_hint')})`}
                aria-label={t('heatmap_zoom_reset')}
              >
                <ArrowCounterclockwise />
              </Button>
            </ButtonGroup>

            {hoveredSensor && (
              <SensorTooltip
                sensorPos={hoveredSensor.pos}
                // Field mode: the sensors are devices, named as in the charts.
                name={
                  fieldRange
                    ? (() => {
                        const sensor = chart?.sensors.find((entry) => entry.pos === hoveredSensor.pos);
                        return sensor?.label ?? sensor?.name;
                      })()
                    : undefined
                }
                meters={hoveredSensor.meters}
                value={hoveredSensor.value}
                unit={fieldUnit ?? undefined}
                decimals={fieldRange ? fieldDecimals : undefined}
                dotColor={
                  fieldRange && fieldRange.max > fieldRange.min
                    ? heatColorAt(
                        colorTable,
                        (hoveredSensor.value - fieldRange.min) / (fieldRange.max - fieldRange.min),
                      )
                    : undefined
                }
                threshold={
                  fieldRange
                    ? null
                    : (chart?.sensors.find((sensor) => sensor.pos === hoveredSensor.pos)?.threshold ?? threshold)
                }
                cursorX={hoveredSensor.cursorX}
                cursorY={hoveredSensor.cursorY}
                containerWidth={wrapSize.width}
                containerHeight={canvasHeight}
              />
            )}

            {cursorInfo && (
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
                {[
                  cursorInfo.meters ? formatMeters(cursorInfo.meters) : null,
                  cursorInfo.heat == null
                    ? null
                    : fieldRange
                      ? formatField(fieldValue(cursorInfo.heat))
                      : `${t('heatmap_heat')} ${cursorInfo.heat.toFixed(2)}`,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
            )}
          </div>
        </>
      )}
    </>
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

export default SensorHeatmap2D;
