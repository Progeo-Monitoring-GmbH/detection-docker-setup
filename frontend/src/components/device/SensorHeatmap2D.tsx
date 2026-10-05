import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Card, Form, Spinner } from 'react-bootstrap';
import { Film } from 'react-bootstrap-icons';
import Plot from 'react-plotly.js';
import { plotTheme } from '../../styles/plotTheme';
import { formatTimestamp } from './heatmapFrames';
import SensorTooltip from './SensorTooltip';
import {
  SensorHeatmapLocation,
  SensorHeatmapResponse,
} from './SensorHeatmap3D';
import {
  AggregationMode,
  useHeatmapFrameExport,
} from './useHeatmapFrameExport';
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
};

type WeightedPoint = {
  pos: number;
  x: number;
  y: number;
  weight: number;
};

type ImageSize = {
  width: number;
  height: number;
};

type HoveredSensor = {
  pos: number;
  x: number;
  y: number;
  value: number;
  cursorX: number;
  cursorY: number;
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
 * Width of the heat field's border around the outermost sensors, in sigmas -
 * at 3 sigma a sensor's kernel has faded to ~1%.
 */
const HEAT_BORDER_SIGMAS = 3;

/**
 * Weighted Gaussian splatting on a regular grid over [-pad, 1 + pad]^2 - the
 * padding lets the heat of sensors on the border fade out instead of being
 * cut off at the outermost points:
 *
 *   heat(x) = sum_i weight_i * exp(-d(x, point_i)^2 / (2 * sigma^2))
 *
 * When `referenceMax` is given (absolute scaling), the accumulated field is
 * divided by it and clamped to [0, 1] - heat only reaches 1 for sensor
 * values far above the alarm threshold. Without it the field is normalized
 * by its own maximum (relative fallback).
 */
const buildWeightedGrid = (
  points: WeightedPoint[],
  resolution: number,
  sigma: number,
  referenceMax: number | null = null,
  pad = 0,
) => {
  const res = Math.max(2, resolution);
  const span = 1 + 2 * pad;
  // Normalized length of one grid cell.
  const cell = span / (res - 1);
  const axis = Array.from({ length: res }, (_, index) => -pad + index * cell);
  const grid = Array.from({ length: res }, () => new Float64Array(res));

  const radiusCells = Math.ceil(clamp(sigma * 3, 0.001, span) / cell);
  const twoSigmaSquared = 2 * sigma * sigma;

  points.forEach((point) => {
    if (!Number.isFinite(point.weight) || point.weight <= 0) {
      return;
    }

    const cx = (clamp(point.x, 0, 1) + pad) / cell;
    const cy = (clamp(point.y, 0, 1) + pad) / cell;
    const startX = Math.max(0, Math.floor(cx - radiusCells));
    const endX = Math.min(res - 1, Math.ceil(cx + radiusCells));
    const startY = Math.max(0, Math.floor(cy - radiusCells));
    const endY = Math.min(res - 1, Math.ceil(cy + radiusCells));

    for (let gy = startY; gy <= endY; gy += 1) {
      const dyNormalized = (gy - cy) * cell;
      for (let gx = startX; gx <= endX; gx += 1) {
        const dxNormalized = (gx - cx) * cell;
        const distanceSquared =
          dxNormalized * dxNormalized + dyNormalized * dyNormalized;
        const kernel = Math.exp(-distanceSquared / twoSigmaSquared);
        grid[gy][gx] += point.weight * kernel;
      }
    }
  });

  let max = 0;
  grid.forEach((row) => {
    row.forEach((value) => {
      if (value > max) {
        max = value;
      }
    });
  });

  if (referenceMax != null && referenceMax > 0) {
    grid.forEach((row) => {
      for (let index = 0; index < row.length; index += 1) {
        row[index] = clamp(row[index] / referenceMax, 0, 1);
      }
    });
  } else if (max > 0) {
    grid.forEach((row) => {
      for (let index = 0; index < row.length; index += 1) {
        row[index] /= max;
      }
    });
  }

  return { axis, grid, max };
};

const SensorHeatmap2D = ({
  response,
  height = 800,
  resolution = 180,
  alignment = null,
  hideChrome = false,
}: SensorHeatmap2DProps) => {
  const [mode, setMode] = useState<AggregationMode>('slice');
  const [timestampIndex, setTimestampIndex] = useState(0);
  const [sigma, setSigma] = useState<'auto' | number>('auto');
  const [imageSize, setImageSize] = useState<ImageSize | null>(null);
  const [hoveredSensor, setHoveredSensor] = useState<HoveredSensor | null>(
    null,
  );

  const plotRef = useRef<HTMLDivElement | null>(null);
  const plotWrapRef = useRef<HTMLDivElement | null>(null);

  const timestamps = useMemo(
    () => (Array.isArray(response?.timestamps) ? response.timestamps : []),
    [response],
  );

  useEffect(() => {
    setTimestampIndex((current) =>
      Math.max(0, Math.min(current, Math.max(timestamps.length - 1, 0))),
    );
  }, [timestamps.length]);

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
    };
  }, [baseLocation, activePlan]);

  const lageplanUrl = useMemo(() => {
    const raw = location?.lageplan_url;

    return raw ? getBackendUrl(raw) : null;
  }, [location]);

  useEffect(() => {
    if (!lageplanUrl) {
      setImageSize(null);
      return undefined;
    }

    let cancelled = false;
    const image = new Image();
    image.onload = () => {
      if (!cancelled) {
        setImageSize({
          width: image.naturalWidth,
          height: image.naturalHeight,
        });
      }
    };
    image.onerror = () => {
      if (!cancelled) {
        setImageSize(null);
      }
    };
    image.src = lageplanUrl;

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
        x: Number(point.x),
        // ny = 0 is the top of the plan (as in the alignment wizard); a
        // vertically flipped plan uses ny as-is.
        y: isFlippedY ? Number(point.y) : 1 - Number(point.y),
        series: Array.isArray(data[String(point.pos)])
          ? data[String(point.pos)]
          : [],
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
      x: (index % columns) / Math.max(columns - 1, 1),
      y: 1 - Math.floor(index / columns) / Math.max(rows - 1, 1),
      series: data[key] || [],
    }));
  }, [response, location]);

  const weightedPoints = useMemo<WeightedPoint[]>(() => {
    if (!sensors.length || !timestamps.length) {
      return [];
    }

    return sensors.map((sensor) => {
      let weight = 0;

      if (mode === 'slice') {
        const value = sensor.series[timestampIndex];
        weight =
          value == null || !Number.isFinite(Number(value))
            ? 0
            : Math.abs(Number(value));
      } else if (mode === 'avg') {
        let sum = 0;
        let count = 0;
        sensor.series.forEach((value) => {
          if (value == null || !Number.isFinite(Number(value))) {
            return;
          }
          sum += Math.abs(Number(value));
          count += 1;
        });
        weight = count ? sum / count : 0;
      } else {
        sensor.series.forEach((value) => {
          if (value == null || !Number.isFinite(Number(value))) {
            return;
          }
          weight = Math.max(weight, Math.abs(Number(value)));
        });
      }

      return {
        pos: sensor.pos,
        x: sensor.x,
        y: sensor.y,
        weight,
      };
    });
  }, [sensors, timestamps.length, mode, timestampIndex]);

  const chart = useMemo(() => {
    if (!timestamps.length || !sensors.length) {
      return null;
    }

    const usedSigma =
      sigma === 'auto' ? computeAutoSigma(sensors) : clamp(sigma, 0.005, 0.3);

    // Heat normalization: the field saturates (heat = 1) only when sensor
    // values reach HEAT_FULL_MULTIPLIER times the location's alarm threshold.
    // Without a usable threshold the field falls back to relative scaling.
    const rawThreshold = Number(location?.alarm_threshold);
    const heatReference =
      Number.isFinite(rawThreshold) && rawThreshold > 0
        ? rawThreshold * HEAT_FULL_MULTIPLIER
        : null;

    // Lageplan alignment: the alignment wizard maps normalized coordinates to
    // canvas pixels via  pixel = offset + coord * drawnImageSize * scale. The plot
    // uses a normalized-to-image space where the image always spans
    // [0, 1] x [0, 1] and the sensor coordinates are scaled up by
    // scale_x/scale_y (plus the offsets) so the points land exactly where the
    // wizard placed them on the plan.
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
    const sizeKnown = Boolean(lageplanUrl && imageSize);
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

    // The heat field is computed in normalized space (isotropic kernels);
    // the raster is then stretched onto the scaled plot domain via the trace
    // axes, so heat extends exactly as far as the scaled sensor positions.
    const { axis, grid, max } = buildWeightedGrid(
      weightedPoints,
      resolution,
      usedSigma,
      heatReference,
      HEAT_BORDER_SIGMAS * usedSigma,
    );
    const xAxis = axis.map((value) => toPlotX(value));
    const yAxis = axis.map((value) => toPlotY(value));

    const activeCount = weightedPoints.filter(
      (point) => point.weight > 0,
    ).length;

    // The view is cropped to the sensor points and their heat border (plus a
    // small margin) - the rest of the lageplan is mostly empty paper.
    const margin = 0.02;
    const plotXs = sensors.map((sensor) => toPlotX(sensor.x));
    const plotYs = sensors.map((sensor) => toPlotY(sensor.y));
    const heatXs = [xAxis[0], xAxis[xAxis.length - 1]];
    const heatYs = [yAxis[0], yAxis[yAxis.length - 1]];
    const xMin = Math.min(...plotXs, ...heatXs) - margin;
    const xMax = Math.max(...plotXs, ...heatXs) + margin;
    const yMin = Math.min(...plotYs, ...heatYs) - margin;
    const yMax = Math.max(...plotYs, ...heatYs) + margin;

    // Values shown in the sensor tooltip (per aggregation mode), aligned with
    // the scatter points.
    const sensorValues = sensors.map((sensor, index) => {
      const point = weightedPoints[index];
      return [
        sensor.pos,
        sensor.x,
        sensor.y,
        point ? point.weight : 0,
      ];
    });

    return {
      xAxis,
      yAxis,
      grid,
      max,
      usedSigma,
      activeCount,
      heatReference,
      xRange: [xMin, xMax],
      yRange: [yMin, yMax],
      // Display the lageplan at its true aspect ratio.
      scaleRatio: sizeKnown && imgWidth > 0 ? imgHeight / imgWidth : 1,
      image: lageplanUrl
        ? {
            source: lageplanUrl,
            xref: 'x',
            yref: 'y',
            x: 0,
            y: 1,
            sizex: 1,
            sizey: 1,
            xanchor: 'left',
            yanchor: 'top',
            sizing: 'stretch',
            layer: 'below',
            opacity: 1,
          }
        : null,
      sensorValues,
      sensorScatter: {
        type: 'scatter',
        mode: 'markers+text',
        x: plotXs,
        y: plotYs,
        text: sensors.map((sensor) => String(sensor.pos)),
        textposition: 'top center',
        textfont: { color: '#ffffff', size: 10 },
        marker: {
          color: plotTheme.brandBlue,
          size: 9,
          line: { color: '#ffffff', width: 1 },
        },
        hovertemplate: 'Sensor %{text}<extra></extra>',
        hoverinfo: 'none',
        name: 'Sensors',
        showlegend: false,
        customdata: sensorValues,
      },
    };
  }, [
    sensors,
    weightedPoints,
    timestamps.length,
    sigma,
    resolution,
    location,
    lageplanUrl,
    imageSize,
  ]);

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
    plotRef,
    chartReady: chart != null,
    timestamps,
    mode,
    timestampIndex,
    setTimestampIndex,
    setMode,
  });

  const [wrapSize, setWrapSize] = useState({ width: 0, height: 0 });

  // Measure the wrapper once the plot is mounted so the tooltip can clamp
  // itself to the plot area.
  useEffect(() => {
    const wrap = plotWrapRef.current;
    if (!wrap) {
      return;
    }
    const measure = () => {
      setWrapSize({ width: wrap.clientWidth, height: wrap.clientHeight });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [chart != null]);

  // Show the pretty sensor tooltip when hovering a marker: anchor it near the
  // hovered point (pixel bbox from plotly) inside the plot wrapper.
  const handlePlotHover = (event: {
    points?: Array<{
      customdata?: Array<number | string>;
      bbox?: { x0: number; y0: number; x1: number; y1: number };
    }>;
  }) => {
    // The heatmap cell under the cursor also reports a hover point; pick the
    // sensor marker one, identified by its 4-part customdata.
    const point = (event.points || []).find(
      (candidate) =>
        Array.isArray(candidate.customdata) && candidate.customdata.length >= 4,
    );
    const meta = point?.customdata;
    if (!point || !meta) {
      return;
    }
    const [pos, x, y, value] = meta as number[];

    const wrap = plotWrapRef.current;
    const wrapRect = wrap?.getBoundingClientRect();
    const bbox = point.bbox;
    const cursorX = bbox
      ? bbox.x0 + (bbox.x1 - bbox.x0) / 2
      : wrapRect
        ? wrapRect.width / 2
        : 0;
    const cursorY = bbox
      ? bbox.y0 + (bbox.y1 - bbox.y0) / 2
      : wrapRect
        ? wrapRect.height / 2
        : 0;

    setHoveredSensor({ pos, x, y, value, cursorX, cursorY });
  };

  const handlePlotUnhover = () => setHoveredSensor(null);

  const planSelectValue = plans ? Math.min(planIndex, plans.length - 1) : 0;

  const plotMargin = { l: 4, r: 16, t: 4, b: 4 };

  // Fit the plot height to the content: the axes keep the plan's aspect
  // ratio, so a fixed height would leave empty bands above/below a wide
  // plan. `height` is the upper bound.
  const plotHeight = useMemo(() => {
    if (!chart || wrapSize.width <= 0) {
      return height;
    }
    const xSpan = chart.xRange[1] - chart.xRange[0];
    const ySpan = chart.yRange[1] - chart.yRange[0];
    // Rough width of plotly's (compact) colorbar incl. its labels.
    const colorbarWidth = 50;
    const plotWidth =
      wrapSize.width - plotMargin.l - plotMargin.r - colorbarWidth;
    if (xSpan <= 0 || ySpan <= 0 || plotWidth <= 0) {
      return height;
    }
    const contentHeight = (plotWidth * ySpan * chart.scaleRatio) / xSpan;
    return Math.round(
      clamp(contentHeight + plotMargin.t + plotMargin.b, 160, height),
    );
  }, [chart, wrapSize.width, height, plotMargin.l, plotMargin.r, plotMargin.t, plotMargin.b]);

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

            <Form.Select
              size="sm"
              aria-label="Aggregation mode"
              value={mode}
              onChange={(event) =>
                setMode(event.target.value as AggregationMode)
              }
              style={{ width: 'auto' }}
              disabled={videoExporting}
            >
              <option value="slice">Single timestamp</option>
              <option value="avg">Average</option>
              <option value="max">Maximum</option>
            </Form.Select>

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

            <div className="ms-auto d-flex align-items-center gap-2">
              {videoExporting ? (
                <>
                  <Spinner size="sm" animation="border" />
                  <span className="text-muted small">
                    {videoStage === 'capturing'
                      ? `Frames ${Math.round((videoProgress ?? 0) * 100)}%`
                      : videoStage === 'uploading'
                        ? 'Uploading…'
                        : videoStage === 'rendering'
                          ? 'Rendering video…'
                          : 'Downloading…'}
                  </span>
                </>
              ) : (
                <Button
                  size="sm"
                  variant="outline-danger"
                  onClick={() => void exportFrames()}
                  disabled={timestamps.length < 2}
                  aria-label="Export video"
                  title="Export video: capture the heatmap animation and download a ZIP with the MP4 video and its PNG frames"
                >
                  <Film />
                </Button>
              )}
            </div>
          </div>

          {(mode === 'slice' || sigma !== 'auto') && (
            <div className="d-flex flex-wrap align-items-center gap-3 mt-1">
              {mode === 'slice' && (
                <div className="flex-grow-1" style={{ minWidth: 200 }}>
                  <label
                    htmlFor="heatmap2d-timestamp"
                    className="form-label small text-muted mb-0"
                  >
                    {timestamps.length
                      ? `${timestampIndex + 1}/${timestamps.length}: ${formatTimestamp(timestamps[timestampIndex])}`
                      : 'Timestamp'}
                  </label>
                  <input
                    id="heatmap2d-timestamp"
                    type="range"
                    className="form-range d-block"
                    min={0}
                    max={Math.max(timestamps.length - 1, 0)}
                    step={1}
                    value={timestampIndex}
                    onChange={(event) =>
                      setTimestampIndex(Number(event.target.value))
                    }
                    disabled={videoExporting}
                  />
                </div>
              )}

              {sigma !== 'auto' && (
                <div style={{ width: 180 }}>
                  <label
                    htmlFor="heatmap2d-sigma"
                    className="form-label small text-muted mb-0"
                  >
                    {'σ'} (kernel width): {sigma}
                  </label>
                  <input
                    id="heatmap2d-sigma"
                    type="range"
                    className="form-range d-block"
                    min={0.005}
                    max={0.15}
                    step={0.005}
                    value={sigma}
                    onChange={(event) => setSigma(Number(event.target.value))}
                    disabled={videoExporting}
                  />
                </div>
              )}
            </div>
          )}

          <div className="text-muted" style={{ fontSize: '0.75rem' }}>
            {sensors.length} sensors, {timestamps.length} timestamps
            {chart.activeCount > 0
              ? `, ${chart.activeCount} active, σ=${chart.usedSigma.toFixed(3)}`
              : ''}
            {chart.heatReference ? `, heat=1 ≥ ${chart.heatReference}` : ''}
          </div>
        </div>
      )}

      {!chart ? (
        <div className="text-muted py-5 text-center">
          No sensor measurements available.
        </div>
      ) : (
          <>
            {videoError && (
              <div className="text-danger small mb-2 px-2">{videoError}</div>
            )}
            {videoResultUrl && !videoExporting && (
              <div className="small mb-1 px-2">
                Video ready -{' '}
                <Button
                  variant="link"
                  size="sm"
                  className="p-0 align-baseline"
                  onClick={() => void downloadVideoResult()}
                >
                  download ZIP (MP4 + frames)
                </Button>
              </div>
            )}

            <div
              ref={plotWrapRef}
              className="heatmap2d-plot-wrap"
              style={{ position: 'relative' }}
            >
              <Plot
                ref={plotRef}
                data={[
                  {
                    type: 'heatmap',
                    x: chart.xAxis,
                    y: chart.yAxis,
                    z: chart.grid.map((row) => Array.from(row)),
                    zmin: 0,
                    zmax: 1,
                    colorscale: [
                      [0, plotTheme.brandBlue],
                      [0.35, plotTheme.contrastCyan],
                      [0.65, plotTheme.contrastYellow],
                      [1, plotTheme.brandOrange],
                    ],
                    opacity: 0.7,
                    colorbar: {
                      title: { text: 'Heat', font: { size: 11 } },
                      thickness: 10,
                      xpad: 4,
                      tickfont: { size: 10 },
                      nticks: 6,
                    },
                    hovertemplate: 'Heat: %{z:.3f}<extra></extra>',
                  },
                  chart.sensorScatter,
                ]}
                layout={{
                  height: plotHeight,
                  autosize: true,
                  margin: plotMargin,
                  paper_bgcolor: 'transparent',
                  plot_bgcolor: 'transparent',
                  images: chart.image ? [chart.image] : [],
                  // The axes only position the plan - no ticks, labels or grid.
                  xaxis: {
                    range: chart.xRange,
                    constrain: 'domain',
                    visible: false,
                  },
                  yaxis: {
                    range: chart.yRange,
                    scaleanchor: 'x',
                    scaleratio: chart.scaleRatio,
                    visible: false,
                  },
                  font: { family: 'inherit', color: plotTheme.brandBlue },
                }}
                config={{
                  responsive: true,
                  displaylogo: false,
                  modeBarButtonsToRemove: ['lasso2d', 'select2d'],
                }}
                style={{ width: '100%' }}
                useResizeHandler
                onAfterPlot={handleAfterPlot}
                onHover={handlePlotHover}
                onUnhover={handlePlotUnhover}
              />

              {hoveredSensor && (
                <SensorTooltip
                  sensorPos={hoveredSensor.pos}
                  x={hoveredSensor.x}
                  y={hoveredSensor.y}
                  value={hoveredSensor.value}
                  threshold={
                    Number.isFinite(Number(location?.alarm_threshold))
                      ? Number(location?.alarm_threshold)
                      : null
                  }
                  cursorX={hoveredSensor.cursorX}
                  cursorY={hoveredSensor.cursorY}
                  containerWidth={wrapSize.width}
                  containerHeight={wrapSize.height}
                />
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
