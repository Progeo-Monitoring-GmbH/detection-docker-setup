import { useState, type MouseEvent } from 'react';
import { formatDate } from '../../main/dateFormat';
import { childTestId } from '../../testIds';
import './ThresholdTrendChart.css';

type ThresholdTrendPoint = {
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
  /** Line colour - default: TREND_COLORS in series order. */
  color?: string;
  /** Drawn (highlighted) but not listed in the legend - e.g. a sensor
   * hovered in a table that isn't plotted yet. */
  preview?: boolean;
};

type ThresholdTrendChartProps = {
  series: ThresholdTrendSeries[];
  hiddenSeries: Set<string>;
  onToggleSeries: (id: string) => void;
  emptyLabel: string;
  meanOfLabel: (count: number) => string;
  /** Legend text for the 1x threshold line. */
  thresholdLabel: string;
  /** The series to highlight (the others fade) - e.g. hovered in a table. */
  highlightedId?: string | null;
  /** A line or legend entry is hovered (null when left). */
  onHighlight?: (id: string | null) => void;
  /** data-testid of the chart; its parts are "<testId>-plot", "-series" / "-legend-entry" (key: the series id), ... */
  testId?: string;
};

// Series hues deliberately avoid red/orange/green: those already mean
// "over / under threshold" in the background bands and the orange threshold
// line. The first five validated for colour-vision deficiency (dataviz
// palette check: worst adjacent CVD dE 20.4, normal-vision >= 15); beyond
// the pool the hues repeat - always solid lines, never dashed.
export const TREND_COLORS = [
  '#2a78d6',
  '#eda100',
  '#1a9bb5',
  '#4a3aa7',
  '#e87ba4',
  '#8d6e63',
  '#0b3659',
  '#b07cc6',
  '#6d8a96',
  '#c9a227',
];
/** The not highlighted lines while one is. */
const FADED_OPACITY = 0.18;

const THRESHOLD_COLOR = 'var(--progeo-orange)';

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
  id: string;
  label: string;
  color: string;
  time: number;
  ratio: number;
  count: number;
};

/** Legend sample of a series/threshold line. */
const LegendSwatch = ({ color, width = 2.5 }: { color: string; width?: number }) => (
  <svg width={18} height={6} className="threshold-trend-swatch" aria-hidden="true">
    <line x1={0} x2={18} y1={3} y2={3} stroke={color} strokeWidth={width} strokeLinecap="round" />
  </svg>
);

// The year only once the plotted span crosses a year (long ranges).
const formatTime = (time: number, withYear = false) =>
  formatDate(time, withYear ? 'dateTime' : 'dayMonthTime');

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
 * readable, and shows a hover tooltip snapped to the nearest point - whose
 * line is highlighted, like a hovered legend entry (`onHighlight`). No
 * charting library - a small self-contained SVG (see LageplanZoneOverlay
 * for the same convention).
 */
const ThresholdTrendChart = ({
  series,
  hiddenSeries,
  onToggleSeries,
  emptyLabel,
  meanOfLabel,
  thresholdLabel,
  highlightedId = null,
  onHighlight,
  testId = 'threshold-trend',
}: ThresholdTrendChartProps) => {
  const [hover, setHover] = useState<HoverInfo | null>(null);

  const ratioSeries = series
    .map((entry, index) => {
      const threshold = entry.threshold && entry.threshold > 0 ? entry.threshold : 1;
      return {
        id: entry.id,
        label: entry.label,
        preview: Boolean(entry.preview),
        color: entry.color ?? TREND_COLORS[index % TREND_COLORS.length],
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
      <div className="threshold-trend-empty" data-testid={childTestId(testId, 'empty')}>
        {emptyLabel}
      </div>
    );
  }

  // A highlighted series fades the others - only while it is plotted.
  const highlight =
    highlightedId != null && ratioSeries.some((entry) => entry.id === highlightedId && !hiddenSeries.has(entry.id))
      ? highlightedId
      : null;
  // The highlighted line last, so it is drawn on top.
  const visibleSeries = ratioSeries
    .filter((entry) => !hiddenSeries.has(entry.id))
    .sort((a, b) => Number(a.id === highlight) - Number(b.id === highlight));
  const legendSeries = ratioSeries.filter((entry) => !entry.preview);

  const allTimes = ratioSeries.flatMap((entry) => entry.points.map((point) => point.time));
  const allRatios = ratioSeries.flatMap((entry) => entry.points.map((point) => point.ratio));
  const minTime = Math.min(...allTimes);
  const maxTime = Math.max(...allTimes);
  const maxRatio = Math.max(...allRatios, 1) * 1.15;
  const withYear = new Date(minTime).getFullYear() !== new Date(maxTime).getFullYear();

  const toX = (time: number) =>
    maxTime === minTime ? (X0 + X1) / 2 : X0 + ((time - minTime) / (maxTime - minTime)) * (X1 - X0);
  const toY = (ratio: number) => Y1 - (ratio / maxRatio) * (Y1 - Y0);

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
    const vby = ((event.clientY - rect.top) / rect.height) * VB_H;
    if (vbx < X0 || vbx > X1) {
      setHover(null);
      onHighlight?.(null);
      return;
    }

    // Nearest point to the cursor on screen - series measured at the same
    // times differ only in height.
    let best: HoverInfo | null = null;
    let bestDistance = Infinity;
    displaySeries.forEach((entry) => {
      entry.display.forEach((point) => {
        const distance = Math.hypot(toX(point.time) - vbx, toY(point.ratio) - vby);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = {
            x: toX(point.time),
            y: toY(point.ratio),
            id: entry.id,
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
    // The line under the cursor is highlighted (the others fade).
    onHighlight?.((best as HoverInfo | null)?.id ?? null);
  };

  return (
    <div className="threshold-trend" data-testid={testId}>
      <div className="threshold-trend-plot" data-testid={childTestId(testId, 'plot')}>
        <svg
          viewBox={`0 0 ${VB_W} ${VB_H}`}
          className="threshold-trend-svg"
          onMouseMove={handleMouseMove}
          onMouseLeave={() => {
            setHover(null);
            onHighlight?.(null);
          }}
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
          <line x1={X0} x2={X1} y1={thresholdY} y2={thresholdY} stroke={THRESHOLD_COLOR} strokeWidth={1.3} opacity={0.75} />

          <text x={X0} y={VB_H - 2} textAnchor="start" fontSize={9} fill="#8B8383">
            {formatTime(minTime, withYear)}
          </text>
          <text x={X1} y={VB_H - 2} textAnchor="end" fontSize={9} fill="#8B8383">
            {formatTime(maxTime, withYear)}
          </text>

          {displaySeries.map((entry) => {
            const emphasized = entry.id === highlight;
            const opacity = highlight == null || emphasized ? 1 : FADED_OPACITY;
            return (
              <g key={entry.id} data-series={entry.id} data-testid={childTestId(testId, 'series')} data-test-key={entry.id}>
                <polyline
                  points={entry.display.map((point) => `${toX(point.time)},${toY(point.ratio)}`).join(' ')}
                  fill="none"
                  stroke={entry.color}
                  strokeWidth={emphasized ? 3.2 : 1.8}
                  strokeOpacity={opacity}
                  strokeLinejoin="round"
                />
                {/* Lines only - a single point (no line) as a dot. */}
                {entry.display.length === 1 && (
                  <circle
                    cx={toX(entry.display[0].time)}
                    cy={toY(entry.display[0].ratio)}
                    r={emphasized ? 3.6 : 2.6}
                    fill={entry.color}
                    fillOpacity={opacity}
                  />
                )}
              </g>
            );
          })}

          {hover && (
            <g>
              <line x1={hover.x} x2={hover.x} y1={Y0} y2={Y1} stroke="var(--progeo-blue)" strokeWidth={1} opacity={0.35} />
              <circle cx={hover.x} cy={hover.y} r={5} fill="none" stroke={hover.color} strokeWidth={2.2} />
            </g>
          )}
        </svg>

        {hover && (
          <div
            className="threshold-trend-tooltip"
            data-testid={childTestId(testId, 'tooltip')}
            style={{
              left: `${Math.min(82, Math.max(0, (hover.x / VB_W) * 100))}%`,
              top: `${Math.max(0, (hover.y / VB_H) * 100 - 6)}%`,
            }}
          >
            <div className="threshold-trend-tooltip-title">
              <span className="threshold-trend-tooltip-dot" style={{ background: hover.color }} />
              {hover.label}
            </div>
            <div>
              {formatTime(hover.time, withYear)}
              {hover.count > 1 && <span className="threshold-trend-tooltip-muted"> ({meanOfLabel(hover.count)})</span>}
            </div>
            <div>{formatRatio(hover.ratio)}</div>
          </div>
        )}
      </div>

      <div className="threshold-trend-legend" data-testid={childTestId(testId, 'legend')}>
        {legendSeries.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => onToggleSeries(entry.id)}
            data-testid={childTestId(testId, 'legend-entry')}
            data-test-key={entry.id}
            onMouseEnter={() => onHighlight?.(entry.id)}
            onMouseLeave={() => onHighlight?.(null)}
            onFocus={() => onHighlight?.(entry.id)}
            onBlur={() => onHighlight?.(null)}
            className={[
              'threshold-trend-legend-entry',
              entry.id === highlight ? 'threshold-trend-legend-entry--highlight' : '',
              hiddenSeries.has(entry.id) ? 'threshold-trend-legend-entry--hidden' : '',
            ].filter(Boolean).join(' ')}
          >
            <LegendSwatch color={hiddenSeries.has(entry.id) ? '#B8B0B0' : entry.color} />
            {entry.label}
          </button>
        ))}
        <span className="threshold-trend-legend-threshold">
          <LegendSwatch color={THRESHOLD_COLOR} width={1.3} />
          {thresholdLabel}
        </span>
      </div>
    </div>
  );
};

export default ThresholdTrendChart;
