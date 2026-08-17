import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Card, Form, Spinner } from 'react-bootstrap';
import { Film } from 'react-bootstrap-icons';
import Plot from 'react-plotly.js';
// react-plotly.js renders with the full plotly.js build; import the exact same
// module so Plotly.toImage operates on the instance that owns the graph div.
import Plotly from 'plotly.js/dist/plotly';
import { plotTheme } from '../../styles/plotTheme';
import { buildStoredZip } from './frameZip';
import {
  SensorHeatmapLocation,
  SensorHeatmapResponse,
} from './SensorHeatmap3D';

type SensorHeatmap2DProps = {
  response: SensorHeatmapResponse | null | undefined;
  title?: string;
  height?: number;
  resolution?: number;
  /** Overrides for the lageplan alignment (offset/scale) used in placement. */
  alignment?: SensorHeatmapLocation | null;
};

type AggregationMode = 'slice' | 'avg' | 'max';

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

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => {
    window.setTimeout(resolve, milliseconds);
  });

const formatTimestamp = (timestamp: number | null | undefined) => {
  if (timestamp == null) {
    return 'n/a';
  }
  const date = new Date(timestamp * 1000);
  if (Number.isNaN(date.getTime())) {
    return String(timestamp);
  }
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
};

const getBackendUrl = (path: string) => {
  if (/^https?:\/\//i.test(path)) {
    return path;
  }
  const backendUrl = import.meta.env.VITE_BACKEND_URL || window.location.origin;
  return `${backendUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
};

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
 * Weighted Gaussian splatting on a regular grid over [0, 1] x [0, 1]:
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
) => {
  const res = Math.max(2, resolution);
  const axis = Array.from({ length: res }, (_, index) => index / (res - 1));
  const grid = Array.from({ length: res }, () => new Float64Array(res));

  const radiusCells = Math.ceil(clamp(sigma * 3, 0.001, 1) * (res - 1));
  const twoSigmaSquared = 2 * sigma * sigma;

  points.forEach((point) => {
    if (!Number.isFinite(point.weight) || point.weight <= 0) {
      return;
    }

    const cx = clamp(point.x, 0, 1) * (res - 1);
    const cy = clamp(point.y, 0, 1) * (res - 1);
    const startX = Math.max(0, Math.floor(cx - radiusCells));
    const endX = Math.min(res - 1, Math.ceil(cx + radiusCells));
    const startY = Math.max(0, Math.floor(cy - radiusCells));
    const endY = Math.min(res - 1, Math.ceil(cy + radiusCells));

    for (let gy = startY; gy <= endY; gy += 1) {
      const dyNormalized = (gy - cy) / (res - 1);
      for (let gx = startX; gx <= endX; gx += 1) {
        const dxNormalized = (gx - cx) / (res - 1);
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

// ---------------------------------------------------------------------------
// Frame export helpers: PNG frames are packaged as a (store-only) ZIP, which
// is enough because PNGs are already compressed. The zip is then assembled
// into an MP4 with ffmpeg (scripts are included in the archive).
// ---------------------------------------------------------------------------

const canvasToPngBlob = (canvas: HTMLCanvasElement) =>
  new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, 'image/png');
  });

const downloadBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
};

const loadImageFromDataUrl = (image: HTMLImageElement, dataUrl: string) =>
  new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () =>
      reject(new Error('Could not decode the captured frame.'));
    image.src = dataUrl;
  });

/**
 * Draws the frame timestamp (date/time of that frame) plus a frame counter
 * into the bottom-right corner, on a translucent brand-blue pill.
 */
const drawFrameLabel = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  timestamp: number | null | undefined,
  frameNumber: number,
  totalFrames: number,
) => {
  const text = `${formatTimestamp(timestamp)}  \u00B7  frame ${frameNumber}/${totalFrames}`;
  ctx.font = '600 20px system-ui, -apple-system, "Segoe UI", sans-serif';
  const textWidth = ctx.measureText(text).width;
  const padX = 14;
  const padY = 9;
  const boxWidth = textWidth + padX * 2;
  const boxHeight = 34;
  const x = width - boxWidth - 16;
  const y = height - boxHeight - 16;

  ctx.fillStyle = 'rgba(9, 75, 129, 0.85)';
  if (typeof ctx.roundRect === 'function') {
    ctx.beginPath();
    ctx.roundRect(x, y, boxWidth, boxHeight, 6);
    ctx.fill();
  } else {
    ctx.fillRect(x, y, boxWidth, boxHeight);
  }

  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + padX, y + boxHeight / 2 + padY - 8);
};

const SensorHeatmap2D = ({
  response,
  title = 'Sensor heatmap',
  height = 620,
  resolution = 120,
  alignment = null,
}: SensorHeatmap2DProps) => {
  const [mode, setMode] = useState<AggregationMode>('slice');
  const [timestampIndex, setTimestampIndex] = useState(0);
  const [sigma, setSigma] = useState<'auto' | number>('auto');
  const [imageSize, setImageSize] = useState<ImageSize | null>(null);
  const [videoExporting, setVideoExporting] = useState(false);
  const [videoProgress, setVideoProgress] = useState(0);
  const [videoError, setVideoError] = useState<string | null>(null);

  const plotRef = useRef<HTMLDivElement | null>(null);
  const afterPlotResolvers = useRef<Array<() => void>>([]);

  const timestamps = useMemo(
    () => (Array.isArray(response?.timestamps) ? response.timestamps : []),
    [response],
  );

  useEffect(() => {
    setTimestampIndex((current) =>
      Math.max(0, Math.min(current, Math.max(timestamps.length - 1, 0))),
    );
  }, [timestamps.length]);

  /** Alignment from the view (with_sliders mode) takes precedence. */
  const location = useMemo(
    () => alignment ?? response?.location ?? null,
    [alignment, response],
  );

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
        y: isFlippedY ? 1 - Number(point.y) : Number(point.y),
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
    // image pixels via  pixel = offset + coord * imageSize * scale. The plot
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

    // Offsets are normalized by the image size; they only apply once the
    // image has actually loaded, and degrade gracefully before that.
    const sizeKnown = Boolean(lageplanUrl && imageSize);
    const imgWidth = imageSize?.width ?? 1;
    const imgHeight = imageSize?.height ?? 1;
    const offsetNormX = sizeKnown ? offsetX / imgWidth : 0;
    const offsetNormY = sizeKnown ? offsetY / imgHeight : 0;

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
    );
    const xAxis = axis.map((value) => toPlotX(value));
    const yAxis = axis.map((value) => toPlotY(value));

    const activeCount = weightedPoints.filter(
      (point) => point.weight > 0,
    ).length;

    // Fixed 0.1 margin around the drawn sensor points; the lageplan's
    // [0, 1] span is always included so the plan stays visible behind them.
    const margin = 0.1;
    const plotXs = sensors.map((sensor) => toPlotX(sensor.x));
    const plotYs = sensors.map((sensor) => toPlotY(sensor.y));
    const xMin = Math.min(0, ...plotXs) - margin;
    const xMax = Math.max(1, ...plotXs) + margin;
    const yMin = Math.min(0, ...plotYs) - margin;
    const yMax = Math.max(1, ...plotYs) + margin;

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
        name: 'Sensors',
        showlegend: false,
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

  const waitForPlotRedraw = (timeoutMs = 400) =>
    Promise.race([
      new Promise<void>((resolve) => {
        afterPlotResolvers.current.push(resolve);
      }),
      sleep(timeoutMs),
    ]);

  const handleAfterPlot = () => {
    const resolve = afterPlotResolvers.current.shift();
    resolve?.();
  };

  /**
   * Capture the heatmap animation over all timestamps as PNG frames and
   * download them as a ZIP together with ffmpeg scripts that assemble the
   * frames into an MP4. Frames are captured from the plot itself via
   * Plotly.toImage, drawn onto a canvas with a white background and the
   * frame's timestamp label, and stored as lossless PNGs.
   */
  const exportFrames = async () => {
    const gd = plotRef.current;
    if (!gd || !chart || timestamps.length < 2 || videoExporting) {
      return;
    }

    setVideoExporting(true);
    setVideoProgress(0);
    setVideoError(null);

    const initialMode = mode;
    const initialIndex = timestampIndex;
    const maxFrames = 120;
    const frameStep = Math.max(1, Math.ceil(timestamps.length / maxFrames));
    const frameIndices: number[] = [];
    for (let index = 0; index < timestamps.length; index += frameStep) {
      frameIndices.push(index);
    }
    if (frameIndices[frameIndices.length - 1] !== timestamps.length - 1) {
      frameIndices.push(timestamps.length - 1);
    }

    const width = Math.min(Math.max(gd.clientWidth || 960, 320), 1280);
    const height = Math.min(Math.max(gd.clientHeight || 540, 240), 720);

    try {
      // The animation walks the timestamp slider, so force slice mode for the
      // duration of the export and restore the previous mode afterwards.
      if (mode !== 'slice') {
        setMode('slice');
        await waitForPlotRedraw();
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        throw new Error('Canvas 2D context unavailable.');
      }

      const frameBlobs: Blob[] = [];
      const frameImage = new Image();
      let previousIndex = initialIndex;

      for (let frame = 0; frame < frameIndices.length; frame += 1) {
        const frameIndex = frameIndices[frame];
        if (frameIndex !== previousIndex) {
          setTimestampIndex(frameIndex);
          await waitForPlotRedraw();
          previousIndex = frameIndex;
        }

        const dataUrl = await Plotly.toImage(gd, {
          format: 'png',
          width,
          height,
          scale: 1,
        });
        await loadImageFromDataUrl(frameImage, dataUrl);

        // The plot paper is transparent, so paint a background first to keep
        // the frames from rendering black on dark video players.
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(frameImage, 0, 0, width, height);
        drawFrameLabel(
          ctx,
          width,
          height,
          timestamps[frameIndex],
          frame + 1,
          frameIndices.length,
        );

        const blob = await canvasToPngBlob(canvas);
        if (blob) {
          frameBlobs.push(blob);
        }

        // Let the browser breathe between frames so the progress UI updates.
        await sleep(25);
        setVideoProgress((frame + 1) / frameIndices.length);
      }

      if (!frameBlobs.length) {
        throw new Error('No frames could be captured.');
      }

      const encoder = new TextEncoder();
      const frameFiles = await Promise.all(
        frameBlobs.map(async (blob, index) => ({
          name: `frames/frame_${String(index + 1).padStart(4, '0')}.png`,
          data: new Uint8Array(await blob.arrayBuffer()),
        })),
      );

      const ffmpegCommand =
        'ffmpeg -y -framerate 8 -i frames/frame_%04d.png -c:v libx264 ' +
        '-preset medium -crf 20 -pix_fmt yuv420p -movflags +faststart ' +
        'sensor-heatmap.mp4';

      const makeVideoBat = [
        '@echo off',
        'REM Assemble the sensor heatmap frames into an MP4 (Windows).',
        'REM Requires ffmpeg (https://ffmpeg.org/) on PATH.',
        ffmpegCommand.replace(/%/g, '%%'),
        'if errorlevel 1 goto :error',
        'echo.',
        'echo Done: sensor-heatmap.mp4',
        'pause',
        'exit /b 0',
        ':error',
        'echo ffmpeg failed - is it installed and on PATH?',
        'pause',
        'exit /b 1',
        '',
      ].join('\r\n');

      const makeVideoSh = [
        '#!/usr/bin/env bash',
        '# Assemble the sensor heatmap frames into an MP4 (Linux/macOS).',
        '# Requires ffmpeg (https://ffmpeg.org/) on PATH.',
        'set -e',
        ffmpegCommand,
        'echo "Done: sensor-heatmap.mp4"',
        '',
      ].join('\n');

      const readme = [
        'Sensor heatmap video frames',
        '==========================',
        '',
        'Each frame is a lossless PNG of the heatmap at one timestamp, labeled',
        'with the timestamp date/time and a frame counter.',
        '',
        'To assemble an MP4 with ffmpeg:',
        '',
        `    ${ffmpegCommand}`,
        '',
        'Or run make_video.bat (Windows) / make_video.sh (Linux/macOS) from',
        'this folder after installing ffmpeg (https://ffmpeg.org/).',
        '',
        'Tip: raise -framerate for a smoother video, e.g. -framerate 12.',
        '',
      ].join('\n');

      const zipBlob = buildStoredZip([
        ...frameFiles,
        { name: 'make_video.bat', data: encoder.encode(makeVideoBat) },
        { name: 'make_video.sh', data: encoder.encode(makeVideoSh) },
        { name: 'README.txt', data: encoder.encode(readme) },
      ]);

      downloadBlob(
        zipBlob,
        `sensor-heatmap-frames-${new Date()
          .toISOString()
          .slice(0, 19)
          .replace(/[:T]/g, '-')}.zip`,
      );
      setVideoProgress(1);
    } catch (error) {
      setVideoError((error as Error).message || 'Frame export failed.');
    } finally {
      setTimestampIndex(initialIndex);
      setMode(initialMode);
      setVideoExporting(false);
    }
  };

  return (
    <Card className="border-0 shadow-sm">
      <Card.Body>
        <div className="d-flex flex-wrap justify-content-between align-items-center mb-2 p-3">
          <h5 className="mb-0">{title}</h5>
          {chart && (
            <small className="text-muted">
              {sensors.length} sensors, {timestamps.length} timestamps
              {lageplanUrl ? ', lageplan' : ''}
              {chart.activeCount > 0
                ? `, ${chart.activeCount} active, \u03C3=${chart.usedSigma.toFixed(
                    3,
                  )}`
                : ''}
              {chart.heatReference
                ? `, heat=1 \u2265 ${chart.heatReference}`
                : ''}
            </small>
          )}
        </div>

        {!chart ? (
          <div className="text-muted py-5 text-center">
            No sensor measurements available.
          </div>
        ) : (
          <>
            <div className="d-flex flex-wrap align-items-center gap-3 mb-3 p-3">
              <Form.Select
                aria-label="Aggregation mode"
                value={mode}
                onChange={(event) =>
                  setMode(event.target.value as AggregationMode)
                }
                style={{ width: 170 }}
                disabled={videoExporting}
              >
                <option value="slice">Single timestamp</option>
                <option value="avg">Average</option>
                <option value="max">Maximum</option>
              </Form.Select>

              {mode === 'slice' && (
                <div className="flex-grow-1" style={{ minWidth: 240 }}>
                  <label
                    htmlFor="heatmap2d-timestamp"
                    className="form-label small mb-0"
                  >
                    {timestamps.length
                      ? `Timestamp ${timestampIndex + 1}/${timestamps.length}: ${formatTimestamp(timestamps[timestampIndex])}`
                      : 'Timestamp'}
                  </label>
                  <input
                    id="heatmap2d-timestamp"
                    type="range"
                    className="form-range"
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

              <Form.Check
                type="switch"
                id="heatmap2d-auto-sigma"
                label={'Auto \u03C3'}
                checked={sigma === 'auto'}
                onChange={(event) =>
                  setSigma(event.target.checked ? 'auto' : 0.04)
                }
                disabled={videoExporting}
              />

              {sigma !== 'auto' && (
                <div style={{ width: 200 }}>
                  <label
                    htmlFor="heatmap2d-sigma"
                    className="form-label small mb-0"
                  >
                    {'\u03C3'} (kernel width): {sigma}
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

              <div className="ms-auto d-flex align-items-center gap-2">
                {videoExporting ? (
                  <>
                    <Spinner size="sm" animation="border" />
                    <span className="text-muted small">
                      Rendering frames\u2026{' '}
                      {Math.round((videoProgress ?? 0) * 100)}%
                    </span>
                  </>
                ) : (
                  <Button
                    size="sm"
                    variant="outline-danger"
                    onClick={() => void exportFrames()}
                    disabled={timestamps.length < 2}
                    title="Capture PNG frames of the heatmap animation and download them together with an ffmpeg script that assembles an MP4"
                  >
                    <Film className="me-1" />
                    Export Frames
                  </Button>
                )}
              </div>
            </div>

            {videoError && (
              <div className="text-danger small mb-2">{videoError}</div>
            )}

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
                    title: { text: 'Heat' },
                    thickness: 14,
                  },
                  hovertemplate:
                    'x: %{x:.3f}<br>y: %{y:.3f}<br>Heat: %{z:.3f}<extra></extra>',
                },
                chart.sensorScatter,
              ]}
              layout={{
                height,
                autosize: true,
                margin: { l: 44, r: 16, t: 12, b: 44 },
                paper_bgcolor: 'transparent',
                plot_bgcolor: 'transparent',
                images: chart.image ? [chart.image] : [],
                xaxis: {
                  range: chart.xRange,
                  constrain: 'domain',
                },
                yaxis: {
                  range: chart.yRange,
                  scaleanchor: 'x',
                  scaleratio: chart.scaleRatio,
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
            />
          </>
        )}
      </Card.Body>
    </Card>
  );
};

export default SensorHeatmap2D;
