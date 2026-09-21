import { useState, type MouseEvent } from 'react';

export type ThresholdTrendPoint = {
  id: number | string;
  triggered_at: string | null;
  value: number | null;
};

export type ThresholdTrendSeries = {
  id: string;
  label: string;
  /** The value this series' own readings are relative to (e.g. a measure
   * point's threshold override, or the object's default). Readings are
   * plotted as a multiple of this, not as absolute values, so several
   * sensors with different thresholds stay comparable on one shared scale. */
  threshold: number | null;
  points: ThresholdTrendPoint[];
};

type ThresholdTrendChartProps = {
  series: ThresholdTrendSeries[];
  hiddenSeries: Set<string>;
  onToggleSeries: (id: string) => void;
  emptyLabel: string;
  meanOfLabel: (count: number) => string;
};

const COLORS = ['var(--progeo-orange)', 'var(--progeo-blue)', '#3F7A1C', '#9A7208', '#8B8383'];

// Compact plot area - a short, wide strip instead of a mostly-empty square.
const VB_W = 1000;
const VB_H = 180;
const X0 = 40;
const X1 = 990;
const Y0 = 10;
const Y1 = 148;

// How many resolvable x-axis slots the plot area is treated as having -
// points falling into the same slot are merged (mean time + mean ratio)
// instead of drawn as separate, overlapping dots. Ties the merge threshold
// to the chart's own width rather than a fixed time window, so it adapts to
// whatever range (hours or months) is currently plotted.
const TARGET_SLOTS = 90;

type RawPoint = { id: number | string; time: number; ratio: number };
type DisplayPoint = { key: string; time: number; ratio: number; count: number };

type HoverInfo = {
  x: number;
  y: number;
  label: string;
  color: string;
  time: number;
  ratio: number;
  count: number;
};

const formatTime = (time: number) =>
  new Date(time).toLocaleString(undefined, {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

const formatRatio = (ratio: number) => `${ratio.toFixed(ratio < 10 ? 2 : 0)}x`;

/** Sorted points closer together than `minGapTime` get merged into one mean
 * point, so a burst of near-simultaneous readings shows as a single dot
 * instead of a dense, unreadable cluster. */
const clusterPoints = (points: RawPoint[], minGapTime: number): DisplayPoint[] => {
  const sorted = [...points].sort((a, b) => a.time - b.time);
  const result: DisplayPoint[] = [];
  let bucket: RawPoint[] = [];

  const flushBucket = () => {
    if (bucket.length === 0) {
      return;
    }
    const meanTime = bucket.reduce((sum, point) => sum + point.time, 0) / bucket.length;
    const meanRatio = bucket.reduce((sum, point) => sum + point.ratio, 0) / bucket.length;
    result.push({ key: `c${bucket[0].id}`, time: meanTime, ratio: meanRatio, count: bucket.length });
    bucket = [];
  };

  sorted.forEach((point) => {
    if (bucket.length > 0 && point.time - bucket[0].time > minGapTime) {
      flushBucket();
    }
    bucket.push(point);
  });
  flushBucket();

  return result;
};

/**
 * A compact multi-series time-series chart plotting each series' readings
 * as a multiple of its own threshold (1x = right at the threshold) instead
 * of an absolute value, with a shared green/red background band below/above
 * that line - so sensors with different thresholds stay visually
 * comparable. Merges near-simultaneous points per series to keep the x-axis
 * readable, and shows a hover tooltip snapped to the nearest point. No
 * charting library - a small self-contained SVG (see LageplanZoneOverlay
 * for the same convention).
 */
const ThresholdTrendChart = ({
  series,
  hiddenSeries,
  onToggleSeries,
  emptyLabel,
  meanOfLabel,
}: ThresholdTrendChartProps) => {
  const [hover, setHover] = useState<HoverInfo | null>(null);

  const ratioSeries = series
    .map((entry, index) => {
      const threshold = entry.threshold && entry.threshold > 0 ? entry.threshold : 1;
      return {
        id: entry.id,
        label: entry.label,
        color: COLORS[index % COLORS.length],
        points: entry.points
          .filter((point) => point.triggered_at && point.value != null)
          .map((point) => ({
            id: point.id,
            time: new Date(point.triggered_at as string).getTime(),
            ratio: Number(point.value) / threshold,
          })),
      };
    })
    .filter((entry) => entry.points.length > 0);

  if (ratioSeries.length === 0) {
    return (
      <div
        style={{
          background: 'var(--progeo-surface)',
          borderRadius: 14,
          padding: '22px 16px',
          fontSize: 13,
          color: '#8B8383',
        }}
      >
        {emptyLabel}
      </div>
    );
  }

  const visibleSeries = ratioSeries.filter((entry) => !hiddenSeries.has(entry.id));

  const allTimes = ratioSeries.flatMap((entry) => entry.points.map((point) => point.time));
  const allRatios = ratioSeries.flatMap((entry) => entry.points.map((point) => point.ratio));
  const minTime = Math.min(...allTimes);
  const maxTime = Math.max(...allTimes);
  const maxRatio = Math.max(...allRatios, 1) * 1.15;

  const toX = (time: number) =>
    maxTime === minTime ? (X0 + X1) / 2 : X0 + ((time - minTime) / (maxTime - minTime)) * (X1 - X0);
  const toY = (ratio: number) => Y1 - (ratio / maxRatio) * (Y1 - Y0);
  const toTime = (x: number) => minTime + ((x - X0) / (X1 - X0)) * (maxTime - minTime);

  const minGapTime = (maxTime - minTime) / TARGET_SLOTS;
  const displaySeries = visibleSeries.map((entry) => ({
    ...entry,
    display: clusterPoints(entry.points, minGapTime),
  }));

  const thresholdY = toY(1);
  const yTicks = Array.from(new Set([0, 1, maxRatio])).map((ratio) => ({ ratio, y: toY(ratio) }));

  const handleMouseMove = (event: MouseEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width) {
      return;
    }
    const vbx = ((event.clientX - rect.left) / rect.width) * VB_W;
    if (vbx < X0 || vbx > X1) {
      setHover(null);
      return;
    }
    const cursorTime = toTime(vbx);

    let best: HoverInfo | null = null;
    let bestDistance = Infinity;
    displaySeries.forEach((entry) => {
      entry.display.forEach((point) => {
        const distance = Math.abs(point.time - cursorTime);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = {
            x: toX(point.time),
            y: toY(point.ratio),
            label: entry.label,
            color: entry.color,
            time: point.time,
            ratio: point.ratio,
            count: point.count,
          };
        }
      });
    });
    setHover(best);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ position: 'relative' }}>
        <svg
          viewBox={`0 0 ${VB_W} ${VB_H}`}
          style={{ display: 'block', width: '100%', height: 'auto', cursor: 'crosshair' }}
          onMouseMove={handleMouseMove}
          onMouseLeave={() => setHover(null)}
        >
          {/* Below the threshold (0x-1x) vs. above it (1x-max), so every
              series - regardless of its own absolute threshold - reads
              against the same shared "safe / over" background. */}
          <rect x={X0} y={thresholdY} width={X1 - X0} height={Math.max(0, Y1 - thresholdY)} fill="#3F7A1C" opacity={0.1} />
          <rect x={X0} y={Y0} width={X1 - X0} height={Math.max(0, thresholdY - Y0)} fill="#C44D26" opacity={0.08} />

          {yTicks.map((tick) => (
            <g key={tick.ratio}>
              <line x1={X0} x2={X1} y1={tick.y} y2={tick.y} stroke="var(--progeo-track-soft)" strokeWidth={1} />
              <text x={X0 - 6} y={tick.y + 3} textAnchor="end" fontSize={9} fill="#8B8383">
                {formatRatio(tick.ratio)}
              </text>
            </g>
          ))}
          <line x1={X0} x2={X1} y1={thresholdY} y2={thresholdY} stroke="var(--progeo-orange)" strokeWidth={1.3} strokeDasharray="2 4" opacity={0.75} />

          <text x={X0} y={VB_H - 2} textAnchor="start" fontSize={9} fill="#8B8383">
            {formatTime(minTime)}
          </text>
          <text x={X1} y={VB_H - 2} textAnchor="end" fontSize={9} fill="#8B8383">
            {formatTime(maxTime)}
          </text>

          {displaySeries.map((entry) => (
            <g key={entry.id}>
              <polyline
                points={entry.display.map((point) => `${toX(point.time)},${toY(point.ratio)}`).join(' ')}
                fill="none"
                stroke={entry.color}
                strokeWidth={1.8}
                strokeLinejoin="round"
              />
              {entry.display.map((point) => (
                <circle
                  key={point.key}
                  cx={toX(point.time)}
                  cy={toY(point.ratio)}
                  r={point.count > 1 ? 3.4 : 2.6}
                  fill={entry.color}
                  stroke="#fff"
                  strokeWidth={1}
                />
              ))}
            </g>
          ))}

          {hover && (
            <g>
              <line x1={hover.x} x2={hover.x} y1={Y0} y2={Y1} stroke="var(--progeo-blue)" strokeWidth={1} opacity={0.35} />
              <circle cx={hover.x} cy={hover.y} r={5} fill="none" stroke={hover.color} strokeWidth={2.2} />
            </g>
          )}
        </svg>

        {hover && (
          <div
            style={{
              position: 'absolute',
              left: `${Math.min(82, Math.max(0, (hover.x / VB_W) * 100))}%`,
              top: `${Math.max(0, (hover.y / VB_H) * 100 - 6)}%`,
              transform: 'translate(8px, -100%)',
              background: '#07223A',
              color: '#fff',
              borderRadius: 8,
              padding: '7px 10px',
              fontSize: 11.5,
              lineHeight: 1.5,
              pointerEvents: 'none',
              whiteSpace: 'nowrap',
              boxShadow: '0 6px 18px rgba(11, 54, 89, .3)',
              zIndex: 5,
            }}
          >
            <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: hover.color, display: 'inline-block' }} />
              {hover.label}
            </div>
            <div>
              {formatTime(hover.time)}
              {hover.count > 1 && <span style={{ opacity: 0.7 }}> ({meanOfLabel(hover.count)})</span>}
            </div>
            <div>{formatRatio(hover.ratio)}</div>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        {ratioSeries.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => onToggleSeries(entry.id)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: 0,
              fontFamily: 'inherit',
              fontSize: 12.5,
              fontWeight: 400,
              color: hiddenSeries.has(entry.id) ? '#B8B0B0' : '#6E6868',
            }}
          >
            <span
              style={{
                width: 14,
                height: 2.5,
                borderRadius: 2,
                background: hiddenSeries.has(entry.id) ? '#B8B0B0' : entry.color,
              }}
            />
            {entry.label}
          </button>
        ))}
      </div>
    </div>
  );
};

export default ThresholdTrendChart;
