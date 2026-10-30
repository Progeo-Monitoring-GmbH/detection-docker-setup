/**
 * Geometry and frames of SensorHeatmap2D (extracted so they can be tested
 * without a canvas): the effective Lageplan, where the sensors sit on it and
 * the initial view (the layout - the same for every frame), the heat field
 * of one frame, and what the cursor points at.
 */
import { alignmentBaseScale } from '../ui/ImageCanvasStage';
import {
  containsPoint,
  heatAt,
  heatRect,
  nearestPoint,
  plotToWorld,
  toScreen,
  toWorld,
  WORLD_FALLBACK,
  type View,
  type WorldRect,
  type WorldSize,
} from './heatmapCanvas';
import { buildFieldGrid, buildWeightedGrid, gridAxis, type WeightedPoint } from './heatmapGrid';
import { isCalibrated, pixelToMeters, pointMeters, type ImageSize } from './planMeters';
import type {
  SensorHeatmapLageplanData,
  SensorHeatmapLocation,
  SensorHeatmapResponse,
} from './sensorHeatmapTypes';

/** A sensor in plot coordinates (y upwards), with its readings. */
export type PlotSensor = {
  pos: number;
  /** Normalized position on the plan (y downwards) - null when the sensor
   * isn't placed (fallback grid). */
  nx: number | null;
  ny: number | null;
  x: number;
  y: number;
  series: Array<number | null>;
  threshold: number | null;
  name: string | null;
  /** Field mode: the device and its name in the climate charts. */
  device: number | null;
  label: string | null;
};

/** A sensor at its position on the plan (world = image pixels). */
export type ChartSensor = Omit<PlotSensor, 'x' | 'y' | 'series' | 'threshold'> & {
  wx: number;
  wy: number;
  /** The sensor's own threshold, else the location's; null without one and
   * in field mode (thresholds are alarm levels of the summed heat). */
  threshold: number | null;
};

/** Everything of the heatmap that doesn't change with the frame. */
export type ChartLayout = {
  world: WorldSize;
  resolution: number;
  /** Kernel width from the sensor spacing (computeAutoSigma). */
  autoSigma: number;
  /** Border of the heat field around the sensors (normalized). */
  pad: number;
  xAxis: number[];
  yAxis: number[];
  heatRect: WorldRect;
  /** The initial view: sensors, their heat border and the reference point. */
  bounds: WorldRect;
  sensors: ChartSensor[];
  /** Reference point of the positions in meters (image pixels). */
  reference: [number, number] | null;
};

/** The heat field of one frame. */
export type ChartFrame = {
  grid: Float64Array[];
  /** Field mode: opacity per grid cell (0 away from the sensors). */
  coverage: Float64Array[] | null;
  /** Per sensor (as layout.sensors) its value in the frame. */
  values: number[];
};

export type FieldRange = { min: number; max: number };

/** What the cursor points at: a sensor (index into layout.sensors, at its
 * screen position), else the position in meters and the heat there. */
export type HoverTarget =
  | { kind: 'sensor'; index: number; screen: [number, number]; meters: [number, number] | null }
  | { kind: 'cursor'; meters: [number, number] | null; heat: number | null };

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

/** Space kept free on the right of the initial view for the colour scale. */
export const COLORBAR_SPACE = 58;
/** fitPlan: the tallest canvas, relative to its width (very tall plans). */
const FIT_PLAN_MAX_ASPECT = 2;
/** Hover radius around a sensor marker (screen pixels). */
const SENSOR_HIT_RADIUS = 11;

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

const finiteOr = (raw: unknown, fallback: number) => {
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
};

const positiveOr = (raw: unknown, fallback: number) => {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

/** The location's alarm threshold; null without a positive one. */
export const locationThreshold = (location: SensorHeatmapLocation | null) =>
  positiveOr(location?.alarm_threshold, Number.NaN) || null;

/** Heat normalization: the field saturates (heat = 1) only when sensor values
 * reach HEAT_FULL_MULTIPLIER times the location's alarm threshold. Without a
 * usable threshold the field falls back to relative scaling (null). */
export const heatReference = (location: SensorHeatmapLocation | null) => {
  const threshold = locationThreshold(location);
  return threshold != null ? threshold * HEAT_FULL_MULTIPLIER : null;
};

/**
 * Effective location: the selected Lageplan's url and alignment merged into
 * the location payload (without plans: the location as it is).
 */
export const planLocation = (
  base: SensorHeatmapLocation | null,
  plan: SensorHeatmapLageplanData | null,
): SensorHeatmapLocation | null => {
  if (!plan) {
    return base;
  }
  return {
    ...base,
    lageplan_url: plan.url ?? null,
    offset_x: plan.offset_x ?? 0,
    offset_y: plan.offset_y ?? 0,
    scale_x: plan.scale_x ?? 1,
    scale_y: plan.scale_y ?? 1,
    flip_x: Boolean(plan.flip_x),
    flip_y: Boolean(plan.flip_y),
    reference_x: plan.reference_x ?? null,
    reference_y: plan.reference_y ?? null,
    meters_per_pixel: plan.meters_per_pixel ?? null,
  };
};

/**
 * Sensors at their normalized (nx, ny) positions. The whole codebase treats
 * ny = 0 as the top of the lageplan, so the plot y coordinate is mirrored:
 * y = 1 - ny (a vertically flipped plan uses ny as-is). Without placed
 * sensors, the ones with data are laid out on a regular grid by key order.
 */
export const plotSensors = (
  response: SensorHeatmapResponse | null | undefined,
  flipY: boolean,
): PlotSensor[] => {
  const data = response?.data || {};
  const placed = (response?.sensor_points || [])
    .map((point) => {
      const threshold = Number(point.threshold);
      return {
        pos: point.pos,
        nx: Number(point.x) as number | null,
        ny: Number(point.y) as number | null,
        x: Number(point.x),
        y: flipY ? Number(point.y) : 1 - Number(point.y),
        series: Array.isArray(data[String(point.pos)]) ? data[String(point.pos)] : [],
        threshold: point.threshold != null && Number.isFinite(threshold) ? threshold : null,
        name: point.name ?? null,
        device: point.device ?? null,
        label: point.label ?? null,
      };
    })
    .filter((entry) => Number.isFinite(entry.x) && Number.isFinite(entry.y));
  if (placed.length) {
    return placed;
  }

  const keys = Object.keys(data).sort((a, b) => Number(a) - Number(b));
  const columns = Math.max(Math.ceil(Math.sqrt(keys.length)), 1);
  const rows = Math.max(Math.ceil(keys.length / columns), 1);
  return keys.map((key, index) => ({
    pos: Number(key) || index + 1,
    nx: null,
    ny: null,
    x: (index % columns) / Math.max(columns - 1, 1),
    y: 1 - Math.floor(index / columns) / Math.max(rows - 1, 1),
    series: data[key] || [],
    threshold: null,
    name: null,
    device: null,
    label: null,
  }));
};

/**
 * Auto bandwidth: use the median nearest-neighbour distance so that
 * neighbouring sensors merge into one hot region while isolated sensors
 * keep a reasonably tight kernel ("points attract each other").
 */
export const computeAutoSigma = (points: Array<{ x: number; y: number }>) => {
  const nearest = points
    .map((point, index) =>
      Math.min(
        ...points
          .filter((_, otherIndex) => otherIndex !== index)
          .map((other) => Math.hypot(point.x - other.x, point.y - other.y)),
      ),
    )
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (!nearest.length) {
    return 0.05;
  }
  const median = nearest[Math.floor(nearest.length / 2)];
  return clamp(median * 1.15, 0.008, 0.12);
};

/**
 * Lageplan alignment: the alignment wizard maps normalized coordinates to
 * canvas pixels via  pixel = offset + coord * drawnImageSize * scale. The
 * plot space spans the image as [0, 1] x [0, 1]; the sensor coordinates are
 * scaled by scale_x/scale_y (plus the offsets) so the points land exactly
 * where the wizard placed them on the plan.
 *
 * Offsets are canvas pixels of the alignment wizard (ImageCanvasStage),
 * where the plan is drawn at alignmentBaseScale - so they are normalized by
 * the image size at that scale. They only apply once the image has loaded.
 * Sensor y follows the mirrored convention (see plotSensors), so the plot y
 * transform collapses to  plotY = y * scaleY + (1 - scaleY) - offsetNormY.
 */
const plotTransform = (location: SensorHeatmapLocation | null, imageSize: ImageSize | null) => {
  const scaleX = positiveOr(location?.scale_x ?? 1, 1);
  const scaleY = positiveOr(location?.scale_y ?? 1, 1);
  const wizardScale = imageSize ? alignmentBaseScale(imageSize.width, imageSize.height) : 1;
  const offsetNormX = imageSize
    ? finiteOr(location?.offset_x ?? 0, 0) / (imageSize.width * wizardScale)
    : 0;
  const offsetNormY = imageSize
    ? finiteOr(location?.offset_y ?? 0, 0) / (imageSize.height * wizardScale)
    : 0;
  return {
    toPlotX: (x: number) => offsetNormX + x * scaleX,
    toPlotY: (y: number) => y * scaleY + (1 - scaleY) - offsetNormY,
  };
};

/**
 * The layout of the heatmap: world = pixels of the plan image (without one,
 * a stand-in square); the heat field is computed in normalized space
 * (isotropic kernels) and stretched onto the scaled plot domain, so heat
 * extends exactly as far as the scaled sensor positions.
 *
 * The initial view is cropped to the sensors, their heat border and the
 * reference point (plus a small margin) - the rest of the plan is mostly
 * empty paper. fitPlan: the whole plan (and any sensor beside it), the heat
 * border may run off the edge. Null without sensors.
 */
export const chartLayout = ({
  sensors,
  resolution,
  location,
  imageSize,
  fitPlan,
  fieldMode,
}: {
  sensors: PlotSensor[];
  resolution: number;
  location: SensorHeatmapLocation | null;
  /** Size of the loaded plan image; null while there is none. */
  imageSize: ImageSize | null;
  fitPlan: boolean;
  fieldMode: boolean;
}): ChartLayout | null => {
  if (!sensors.length) {
    return null;
  }
  const autoSigma = computeAutoSigma(sensors);
  const pad = HEAT_BORDER_SIGMAS * autoSigma;
  const { toPlotX, toPlotY } = plotTransform(location, imageSize);
  const world: WorldSize = imageSize
    ? { width: imageSize.width, height: imageSize.height }
    : { width: WORLD_FALLBACK, height: WORLD_FALLBACK };

  const { axis } = gridAxis(resolution, pad);
  const xAxis = axis.map(toPlotX);
  const yAxis = axis.map(toPlotY);
  const field = heatRect(xAxis, yAxis, world);

  const fallbackThreshold = locationThreshold(location);
  const placed = sensors.map((sensor): ChartSensor => {
    const [wx, wy] = plotToWorld(toPlotX(sensor.x), toPlotY(sensor.y), world);
    return {
      pos: sensor.pos,
      wx,
      wy,
      nx: sensor.nx,
      ny: sensor.ny,
      threshold: fieldMode ? null : (sensor.threshold ?? fallbackThreshold),
      name: sensor.name,
      device: sensor.device,
      label: sensor.label,
    };
  });

  const reference: [number, number] | null =
    imageSize && isCalibrated(location)
      ? [location?.reference_x as number, location?.reference_y as number]
      : null;

  const fitWholePlan = fitPlan && imageSize != null;
  const extent = fitWholePlan
    ? { xs: [0, world.width], ys: [0, world.height] }
    : { xs: [field.left, field.right], ys: [field.top, field.bottom] };
  const xs = [...extent.xs, ...placed.map((s) => s.wx), ...(reference ? [reference[0]] : [])];
  const ys = [...extent.ys, ...placed.map((s) => s.wy), ...(reference ? [reference[1]] : [])];
  const margin = (fitWholePlan ? 0.005 : 0.02) * Math.max(world.width, world.height);

  return {
    world,
    resolution,
    autoSigma,
    pad,
    xAxis,
    yAxis,
    heatRect: field,
    bounds: {
      left: Math.min(...xs) - margin,
      right: Math.max(...xs) + margin,
      top: Math.min(...ys) - margin,
      bottom: Math.max(...ys) + margin,
    },
    sensors: placed,
    reference,
  };
};

/**
 * Heat of each sensor at frame `index`. Field mode: the reading itself
 * (temperatures can be negative), NaN without one - left out of the field;
 * otherwise its magnitude, 0 without one.
 */
export const frameWeights = (sensors: PlotSensor[], index: number, fieldMode: boolean): WeightedPoint[] =>
  sensors.map((sensor) => {
    const value = Number(sensor.series[index] ?? Number.NaN);
    const missing = !Number.isFinite(value);
    const fieldWeight = missing ? Number.NaN : value;
    const heatWeight = missing ? 0 : Math.abs(value);
    return { pos: sensor.pos, x: sensor.x, y: sensor.y, weight: fieldMode ? fieldWeight : heatWeight };
  });

/** The heat field of one frame: summed heat (buildWeightedGrid), or in field
 * mode the interpolated readings on the `fieldRange` scale (buildFieldGrid). */
export const chartFrame = (
  layout: ChartLayout,
  weights: WeightedPoint[],
  {
    sigma,
    heatReference: reference,
    fieldRange,
  }: { sigma: 'auto' | number; heatReference: number | null; fieldRange: FieldRange | null },
): ChartFrame => {
  const usedSigma = sigma === 'auto' ? layout.autoSigma : clamp(sigma, 0.005, 0.3);
  const { grid, coverage } = fieldRange
    ? buildFieldGrid(weights, layout.resolution, usedSigma, fieldRange, layout.pad)
    : {
        grid: buildWeightedGrid(weights, layout.resolution, usedSigma, reference, layout.pad).grid,
        coverage: null,
      };
  return { grid, coverage, values: weights.map((point) => point.weight) };
};

/**
 * Fit the canvas height to the content: the view keeps the plan's aspect
 * ratio, so a fixed height would leave empty bands above/below a wide plan.
 * `height` is the upper bound - with fitPlan the full width counts instead
 * (up to FIT_PLAN_MAX_ASPECT), so a tall plan doesn't leave empty bands
 * beside it.
 */
export const canvasHeightFor = (
  bounds: WorldRect | null,
  width: number,
  height: number,
  fitPlan: boolean,
) => {
  const usable = width - COLORBAR_SPACE;
  const spanX = bounds ? bounds.right - bounds.left : 0;
  const spanY = bounds ? bounds.bottom - bounds.top : 0;
  if (width <= 0 || spanX <= 0 || spanY <= 0 || usable <= 0) {
    return height;
  }
  const maxHeight = fitPlan ? Math.max(height, usable * FIT_PLAN_MAX_ASPECT) : height;
  return Math.round(clamp((usable * spanY) / spanX, 160, maxHeight));
};

/** Whether the screen point lies on the drawn plan (without one: the heat
 * field) - only there the wheel zooms instead of scrolling the page. */
export const isOverDrawn = (layout: ChartLayout, view: View, hasImage: boolean, sx: number, sy: number) => {
  const drawn = hasImage
    ? { left: 0, top: 0, right: layout.world.width, bottom: layout.world.height }
    : layout.heatRect;
  const [wx, wy] = toWorld(view, sx, sy);
  return containsPoint(drawn, wx, wy);
};

/**
 * What the screen point (sx, sy) points at: the nearest sensor within
 * SENSOR_HIT_RADIUS, else the position in meters (inside a calibrated plan)
 * and the heat there - a field has no value where it fades out. Null when
 * there is neither.
 */
export const hoverTarget = (
  layout: ChartLayout,
  frame: ChartFrame,
  view: View,
  location: SensorHeatmapLocation | null,
  imageSize: ImageSize | null,
  sx: number,
  sy: number,
): HoverTarget | null => {
  const screenPoints = layout.sensors.map((sensor) => toScreen(view, sensor.wx, sensor.wy));
  const index = nearestPoint(screenPoints, sx, sy, SENSOR_HIT_RADIUS);
  if (index != null) {
    const sensor = layout.sensors[index];
    return {
      kind: 'sensor',
      index,
      screen: screenPoints[index],
      meters:
        sensor.nx != null && sensor.ny != null
          ? pointMeters(sensor.nx, sensor.ny, location, imageSize)
          : null,
    };
  }
  const { world, xAxis, yAxis } = layout;
  const [wx, wy] = toWorld(view, sx, sy);
  const insidePlan = wx >= 0 && wy >= 0 && wx <= world.width && wy <= world.height;
  const covered = frame.coverage
    ? (heatAt(frame.coverage, xAxis, yAxis, wx, wy, world) ?? 0) > 0
    : true;
  const heat = covered ? heatAt(frame.grid, xAxis, yAxis, wx, wy, world) : null;
  const meters = layout.reference && insidePlan ? pixelToMeters(wx, wy, location) : null;
  return meters || heat != null ? { kind: 'cursor', meters, heat } : null;
};
