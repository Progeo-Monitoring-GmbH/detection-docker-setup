import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Card, Form, Spinner } from 'react-bootstrap';
import { Film } from 'react-bootstrap-icons';
import Plot from 'react-plotly.js';
// react-plotly.js renders with the full plotly.js build; import the exact same
// module so Plotly.toImage operates on the instance that owns the graph div.
import Plotly from 'plotly.js/dist/plotly';
import { plotTheme } from '../../styles/plotTheme';
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
 * Weighted Gaussian splatting on a regular grid over [0, 1] x [0, 1]:
 *
 *   heat(x) = sum_i weight_i * exp(-d(x, point_i)^2 / (2 * sigma^2))
 *
 * The accumulated field is normalized to [0, 1] afterwards.
 */
const buildWeightedGrid = (
  points: WeightedPoint[],
  resolution: number,
  sigma: number,
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

  if (max > 0) {
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
    const { axis, grid, max } = buildWeightedGrid(
      weightedPoints,
      resolution,
      usedSigma,
    );

    const activeCount = weightedPoints.filter(
      (point) => point.weight > 0,
    ).length;

    // Lageplan placement: the alignment wizard maps normalized coords to
    // image pixels via  pixel = offset + coord * imageSize * scale. Invert
    // that mapping so the image lands exactly under the (mirrored) sensor
    // coordinates. The image's natural size is only needed when offsets are
    // non-zero, so it degrades gracefully while the image is still loading.
    const rawScaleX = Number(location?.scale_x ?? 1);
    const rawScaleY = Number(location?.scale_y ?? 1);
    const rawOffsetX = Number(location?.offset_x ?? 0);
    const rawOffsetY = Number(location?.offset_y ?? 0);
    const scaleX = Number.isFinite(rawScaleX) && rawScaleX > 0 ? rawScaleX : 1;
    const scaleY = Number.isFinite(rawScaleY) && rawScaleY > 0 ? rawScaleY : 1;
    const offsetX = Number.isFinite(rawOffsetX) ? rawOffsetX : 0;
    const offsetY = Number.isFinite(rawOffsetY) ? rawOffsetY : 0;

    const sizeKnown = Boolean(lageplanUrl && imageSize);
    const imgWidth = imageSize?.width ?? 1;
    const imgHeight = imageSize?.height ?? 1;

    const xLeft = sizeKnown ? -offsetX / (imgWidth * scaleX) + 0.1 : 0;
    const xSize = 1 / scaleX;
    const vTop = sizeKnown ? 1 + offsetY / (imgHeight * scaleY) - 0.07 : 1;
    const vSize = 1 / scaleY;

    const pad = 0.1; // 5% padding around the image and sensors
    const xMin = Math.min(0, xLeft);
    const xMax = Math.max(1, xLeft + xSize);
    const yMin = Math.min(0, vTop - vSize);
    const yMax = Math.max(1, vTop);
    const xPad = (xMax - xMin) * pad || pad;
    const yPad = (yMax - yMin) * pad || pad;

    return {
      axis,
      grid,
      max,
      usedSigma,
      activeCount,
      xRange: [xMin - xPad, xMax + xPad],
      yRange: [yMin - yPad, yMax + yPad],
      image: lageplanUrl
        ? {
            source: lageplanUrl,
            xref: 'x',
            yref: 'y',
            x: xLeft,
            y: vTop - 0.1,
            sizex: xSize,
            sizey: vSize,
            xanchor: 'left',
            yanchor: 'top',
            sizing: 'contain',
            layer: 'below',
            opacity: 1,
          }
        : null,
      sensorScatter: {
        type: 'scatter',
        mode: 'markers+text',
        x: sensors.map((sensor) => sensor.x),
        y: sensors.map((sensor) => sensor.y),
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
   * Record the heatmap animation over all timestamps and download it as a
   * video. Frames are captured from the plot itself (Plotly.toImage), drawn
   * onto an offscreen canvas and muxed in real time with MediaRecorder.
   * MP4 is used when the browser supports it, otherwise it falls back to
   * WebM.
   */
  const exportVideo = async () => {
    const gd = plotRef.current;
    if (!gd || !chart || timestamps.length < 2 || videoExporting) {
      return;
    }

    setVideoExporting(true);
    setVideoProgress(0);
    setVideoError(null);

    const initialMode = mode;
    const initialIndex = timestampIndex;
    const fps = 8;
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

      const videoCanvas = document.createElement('canvas');
      videoCanvas.width = width;
      videoCanvas.height = height;
      const ctx = videoCanvas.getContext('2d');
      if (!ctx) {
        throw new Error('Canvas 2D context unavailable.');
      }

      const mimeTypes = [
        'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
        'video/mp4;codecs=avc1',
        'video/mp4',
        'video/webm;codecs=vp9',
        'video/webm;codecs=vp8',
        'video/webm',
      ];
      const mimeType =
        mimeTypes.find((type) => MediaRecorder.isTypeSupported(type)) || '';
      const fileExt = mimeType.includes('mp4') ? 'mp4' : 'webm';

      const stream = videoCanvas.captureStream(fps);
      const recorder = new MediaRecorder(
        stream,
        mimeType ? { mimeType, videoBitsPerSecond: 8_000_000 } : undefined,
      );

      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          chunks.push(event.data);
        }
      };
      const stopped = new Promise<void>((resolve) => {
        recorder.onstop = () => resolve();
      });

      recorder.start();

      try {
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
          await new Promise<void>((resolve, reject) => {
            frameImage.onload = () => resolve();
            frameImage.onerror = () =>
              reject(new Error('Could not decode the video frame.'));
            frameImage.src = dataUrl;
          });
          ctx.drawImage(frameImage, 0, 0, width, height);

          if (frame < frameIndices.length - 1) {
            await sleep(1000 / fps);
          }
          setVideoProgress((frame + 1) / frameIndices.length);
        }
      } finally {
        recorder.stop();
        await stopped;
      }

      if (!chunks.length) {
        throw new Error('The browser produced no video data.');
      }

      const blob = new Blob(chunks, { type: mimeType || 'video/webm' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `sensor-heatmap-${new Date()
        .toISOString()
        .slice(0, 19)
        .replace(/[:T]/g, '-')}.${fileExt}`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setVideoProgress(1);
    } catch (error) {
      setVideoError((error as Error).message || 'Video export failed.');
    } finally {
      setTimestampIndex(initialIndex);
      setMode(initialMode);
      setVideoExporting(false);
    }
  };

  return (
    <Card className="border-0 shadow-sm">
      <Card.Body>
        <div className="d-flex flex-wrap justify-content-between align-items-center mb-2">
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
            </small>
          )}
        </div>

        {!chart ? (
          <div className="text-muted py-5 text-center">
            No sensor measurements available.
          </div>
        ) : (
          <>
            <div className="d-flex flex-wrap align-items-center gap-3 mb-3">
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
                      Rendering video\u2026{' '}
                      {Math.round((videoProgress ?? 0) * 100)}%
                    </span>
                  </>
                ) : (
                  <Button
                    size="sm"
                    variant="outline-danger"
                    onClick={() => void exportVideo()}
                    disabled={timestamps.length < 2}
                    title="Record the heatmap animation over all timestamps (MP4 or WebM)"
                  >
                    <Film className="me-1" />
                    Export MP4
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
                  x: chart.axis,
                  y: chart.axis,
                  z: chart.grid.map((row) => Array.from(row)),
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
                  title: { text: 'x (normalized)' },
                  range: chart.xRange,
                  constrain: 'domain',
                },
                yaxis: {
                  title: { text: 'y (normalized)' },
                  range: chart.yRange,
                  scaleanchor: 'x',
                  scaleratio: 1,
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
