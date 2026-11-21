import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { plotTheme } from '../../styles/plotTheme';
import { childTestId, repeatedTestId } from '../../testIds';
import { labelEveryOf, snapped, snapStepOf } from '../../main/thresholdMixer';
import PlotHelp from '../ui/PlotHelp';
import { sensorThresholdOf, THRESHOLD_AREA_FILL } from './sensorThresholdArea';
import PillButton from '../ui/kit/PillButton';
import { useWheelHint, useZoomWheel, WheelZoomHint } from '../ui/wheelZoom';
import { DISABLED_SENSOR_FILL, DISABLED_SENSOR_STROKE } from './disabledSensors';
import MeasurementCompareTooltip, { type CompareTooltipData } from './MeasurementCompareTooltip';
import {
  columnSlots,
  columnWidthOf,
  type CurrentSeries,
  niceTicks,
  peakOf,
  type SensorSpread,
  shownSensors,
} from './sensorColumns';
import useElementWidth from '../ui/useElementWidth';
import './SensorColumnsPlot.css';

const PLOT_TOP = 10;
const PLOT_H = 260;
const AXIS_H = 24;
const SVG_H = PLOT_TOP + PLOT_H + AXIS_H;
const GUTTER = 58;
const TOOLTIP_INSET = 8;

const COLORS = {
  ep: '#dc2626',
  wp: '#2563eb',
  sum: plotTheme.contrastViolet,
  whisker: 'rgba(153, 27, 27, 0.7)',
  sigma: 'rgba(252, 122, 46, 0.5)',
  mean: plotTheme.brandBlue,
  threshold: THRESHOLD_AREA_FILL,
  filter: 'rgba(11, 54, 89, 0.06)',
  filterLine: '#8B8383',
  grid: 'rgba(11, 54, 89, 0.08)',
  baseline: '#4a4a4a',
  muted: '#8B8383',
  hover: 'rgba(11, 54, 89, 0.05)',
};

/** What a legend entry switches. */
type Part = 'minmax' | 'sigma' | 'mean' | CurrentSeries | 'masks';
const DEFAULT_PARTS: ReadonlySet<Part> = new Set(['minmax', 'sigma', 'mean', 'ep', 'wp', 'masks']);

type SensorColumnsPlotProps = {
  /** Sensors (pair index 0..count-1). */
  count: number;
  /** WP − EP per sensor over the period. */
  spread: SensorSpread;
  /** The slider's measurement per sensor; null without one. */
  current: { ep: number[]; wp: number[] } | null;
  /** Its time, shown in the tooltip. */
  currentLabel?: string | null;
  /** A Störungsprofil's masks per sensor: outlines over the EP / WP bars. */
  masks?: { ep: number[]; wp: number[] } | null;
  /** The location's alarm threshold: ±it is the green area. */
  threshold: number | null;
  /** Sensors (pair index) with an own threshold. */
  sensorThresholds?: ReadonlyMap<number, number> | null;
  /** Switched off: gray (disabledSensors.ts). */
  disabledSensors?: ReadonlySet<number> | null;
  /** The sensors the second plot follows - tinted in their colour. */
  selected: readonly number[];
  colorOf: (sensor: number) => string;
  /** A click on a column: follow the sensor below, or stop. */
  onToggleSensor: (sensor: number) => void;
  /** The y range over all measurements of the period (locked while sliding);
   * the second one includes WP + EP. Null: from the shown values. */
  yRange: [number, number] | null;
  yRangeWithSum?: [number, number] | null;
  testId?: string;
};

const format = (value: number | null | undefined) =>
  value == null || !Number.isFinite(value) ? '–' : value.toFixed(2);

/**
 * The measurements' first plot, built like the threshold mixer: a column per
 * sensor - slim for 4 sensors, scrolling (Ctrl + wheel zooms) for 300 - with
 * the period's spread of WP − EP on the left (whisker min–max, box the middle 50 % (25th-75th percentile),
 * mean) and the slider's measurement on the right (bars EP | WP, WP + EP on
 * demand), side by side so nothing hides anything. The green area is ±the
 * alarm threshold. The grip on the axis hides every sensor whose |WP − EP|
 * stays below its level in the period (followed ones stay). A click
 * follows a sensor in the second plot.
 */
const SensorColumnsPlot = ({
  count,
  spread,
  current,
  currentLabel = null,
  masks = null,
  threshold,
  sensorThresholds = null,
  disabledSensors = null,
  selected,
  colorOf,
  onToggleSensor,
  yRange,
  yRangeWithSum = null,
  testId = 'sensor-columns',
}: SensorColumnsPlotProps) => {
  const { t } = useTranslation();
  const [parts, setParts] = useState<ReadonlySet<Part>>(DEFAULT_PARTS);
  const [level, setLevel] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [hovered, setHovered] = useState<number | null>(null);
  const [zoom, setZoom] = useState<number | null>(null);
  const [wheelHint, showWheelHint] = useWheelHint();
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const width = useElementWidth(scrollerRef);
  const gutterRef = useRef<SVGSVGElement | null>(null);


  const shown = useMemo(() => shownSensors(count, spread, level, selected), [count, spread, level, selected]);
  const column = columnWidthOf(width, shown.length, zoom);
  const plotWidth = Math.max(width, column * shown.length);

  useZoomWheel(
    scrollerRef,
    (event) => setZoom((currentZoom) => (currentZoom ?? column) * (event.deltaY < 0 ? 1.25 : 0.8)),
    showWheelHint,
  );

  // -- y scale ---------------------------------------------------------------
  const withSum = parts.has('sum');
  const [low, high] = useMemo((): [number, number] => {
    const locked = withSum ? (yRangeWithSum ?? yRange) : yRange;
    if (locked) {
      return locked;
    }
    const values = [0, ...spread.min, ...spread.max, ...(current ? [...current.ep, ...current.wp] : [])];
    const lo = Math.min(...values);
    const hi = Math.max(...values, 1);
    const pad = (hi - lo) * 0.05;
    return [lo < 0 ? lo - pad : 0, hi + pad];
  }, [withSum, yRange, yRangeWithSum, spread, current]);
  const span = high - low || 1;
  const toY = (value: number) => PLOT_TOP + ((high - Math.min(Math.max(value, low), high)) / span) * PLOT_H;
  const step = snapStepOf(span);
  const levelAt = (y: number) => Math.max(0, snapped(high - ((y - PLOT_TOP) / PLOT_H) * span, step));
  const ticks = niceTicks(low, high);

  // -- what a column shows -----------------------------------------------------
  const bars = (['ep', 'wp', 'sum'] as const).filter((key) => parts.has(key) && current);
  const withSpread = parts.has('minmax') || parts.has('sigma') || parts.has('mean');
  const slots = columnSlots(withSpread, bars);
  const valueOf = (key: CurrentSeries, sensor: number) => {
    const ep = current?.ep[sensor];
    const wp = current?.wp[sensor];
    if (ep == null || wp == null) {
      return null;
    }
    return key === 'ep' ? ep : key === 'wp' ? wp : ep + wp;
  };
  const thresholdOf = (sensor: number) => sensorThresholdOf(sensor, threshold, sensorThresholds);

  const toggle = (part: Part) =>
    setParts((currentParts) => {
      const next = new Set(currentParts);
      if (!next.delete(part)) {
        next.add(part);
      }
      return next;
    });

  // -- the "hide below" grip -----------------------------------------------------
  const levelFromPointer = (event: PointerEvent<SVGElement>) => {
    const box = gutterRef.current?.getBoundingClientRect();
    if (box) {
      setLevel(levelAt(event.clientY - box.top));
    }
  };
  const onGripDown = (event: PointerEvent<SVGElement>) => {
    event.preventDefault();
    setDragging(true);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // jsdom / old browsers: the drag still works while over the grip.
    }
  };
  const onGripKey = (event: KeyboardEvent<SVGElement>) => {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      const by = (event.shiftKey ? 10 : 1) * step;
      setLevel((value) => Math.max(0, snapped(value + (event.key === 'ArrowUp' ? by : -by), step)));
    }
  };

  // -- pointer over the columns ---------------------------------------------------
  const sensorAt = (event: PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return shown[Math.floor((event.clientX - box.left) / column)] ?? null;
  };

  const tooltip = useMemo((): CompareTooltipData | null => {
    if (hovered == null) {
      return null;
    }
    const sensorThreshold = thresholdOf(hovered);
    const rows = [
      ...bars.map((key) => ({
        key,
        name: key === 'sum' ? 'WP + EP' : key.toUpperCase(),
        color: COLORS[key],
        value: format(valueOf(key, hovered)),
      })),
      ...(withSpread
        ? [
            {
              key: 'mean',
              name: t('measurement_compare_mean_label'),
              color: COLORS.mean,
              value: `${format(spread.mean[hovered])} (${t('measurement_compare_sigma_label')} ${format(spread.sigma[hovered])})`,
            },
            {
              key: 'sigma',
              name: t('measurement_compare_deviation_label'),
              color: COLORS.sigma,
              band: true,
              value: `${format(spread.lower[hovered])} – ${format(spread.upper[hovered])}`,
            },
            {
              key: 'minmax',
              name: t('measurement_compare_min_max_label'),
              color: COLORS.whisker,
              band: true,
              value: `${format(spread.min[hovered])} – ${format(spread.max[hovered])}`,
            },
          ]
        : []),
      ...(masks && parts.has('masks')
        ? [
            { key: 'mask-ep', name: t('noise_profile_mask_ep'), color: COLORS.ep, value: format(masks.ep[hovered]) },
            { key: 'mask-wp', name: t('noise_profile_mask_wp'), color: COLORS.wp, value: format(masks.wp[hovered]) },
          ]
        : []),
      ...(sensorThreshold != null
        ? [{ key: 'threshold', name: t('measurement_compare_threshold_label'), color: COLORS.threshold, band: true, value: `±${format(sensorThreshold)}` }]
        : []),
    ];
    return {
      title: `${t('measurement_compare_pair_label')} ${hovered + 1}`,
      subtitle: currentLabel,
      rows,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- derived from the listed state
  }, [hovered, parts, current, spread, masks, threshold, sensorThresholds, currentLabel, t]);

  const legendEntry = (part: Part, label: string, swatch: ReactNode) => (
    <button
      type="button"
      key={part}
      className={`sensor-columns-legend-item${parts.has(part) ? '' : ' sensor-columns-legend-item--off'}`}
      aria-pressed={parts.has(part)}
      onClick={() => toggle(part)}
      {...repeatedTestId(`${testId}-legend`, part)}
    >
      {swatch}
      {label}
    </button>
  );
  const swatch = (className: string, color?: string) => (
    <span className={`sensor-columns-swatch ${className}`} style={color ? { background: color } : undefined} />
  );

  const every = labelEveryOf(column);
  const hidden = count - shown.length;
  const radius = Math.min(3, column / 12);

  return (
    <div className="sensor-columns" data-testid={testId}>
      {/* Legend and the filter, left-aligned with the text above. */}
      <div className="sensor-columns-toolbar">
        <div className="sensor-columns-legend" data-testid={childTestId(testId, 'legend')}>
          {legendEntry('minmax', t('measurement_compare_min_max_label'), swatch('sensor-columns-swatch--whisker'))}
          {legendEntry('sigma', t('measurement_compare_deviation_label'), swatch('', COLORS.sigma))}
          {legendEntry('mean', t('measurement_compare_mean_label'), swatch('sensor-columns-swatch--line', COLORS.mean))}
          {current && legendEntry('ep', 'EP', swatch('', COLORS.ep))}
          {current && legendEntry('wp', 'WP', swatch('', COLORS.wp))}
          {current && legendEntry('sum', 'WP + EP', swatch('', COLORS.sum))}
          {masks && legendEntry('masks', t('noise_profile_masks_legend'), swatch('sensor-columns-swatch--outline'))}
          <span className="sensor-columns-legend-static">
            {swatch('', COLORS.threshold)}
            {t('measurement_compare_threshold_label')}
          </span>
        </div>
        <span className="sensor-columns-spacer" />
        <span className="sensor-columns-filter" data-testid={childTestId(testId, 'filter')}>
          {level > 0
            ? t('measurement_columns_hidden', { count: hidden, total: count, value: format(level) })
            : t('measurement_columns_filter_hint')}
        </span>
        {level > 0 && (
          <PillButton
            variant="ghost"
            label={t('measurement_columns_show_all')}
            onClick={() => setLevel(0)}
            testId={childTestId(testId, 'show-all')}
          />
        )}
        {zoom != null && (
          <PillButton
            variant="ghost"
            label={t('measurement_columns_zoom_reset')}
            onClick={() => setZoom(null)}
            testId={childTestId(testId, 'zoom-reset')}
          />
        )}
        <PlotHelp topic="by_sensor" testId={childTestId(testId, 'help')} />
      </div>

      <div className="sensor-columns-chart">
        {/* The y-axis with the "hide below" grip stays put while the columns scroll. */}
        <svg ref={gutterRef} width={GUTTER} height={SVG_H} className="sensor-columns-gutter">
          <text
            transform={`translate(12 ${PLOT_TOP + PLOT_H / 2}) rotate(-90)`}
            textAnchor="middle"
            fontSize={10.5}
            fill={COLORS.muted}
          >
            {t('measurement_compare_absolute_delta_axis')}
          </text>
          {ticks.map((tick) => (
            <text key={tick} x={GUTTER - 8} y={toY(tick) + 3} textAnchor="end" fontSize={10} fill={COLORS.muted}>
              {tick}
            </text>
          ))}
          <g
            role="slider"
            tabIndex={0}
            aria-label={t('measurement_columns_filter_hint')}
            aria-valuenow={level}
            aria-valuemin={0}
            aria-valuemax={Math.round(high)}
            className={`sensor-columns-grip${dragging ? ' sensor-columns-grip--dragging' : ''}`}
            data-testid={childTestId(testId, 'grip')}
            onPointerDown={onGripDown}
            onPointerMove={(event) => dragging && levelFromPointer(event)}
            onPointerUp={() => setDragging(false)}
            onPointerCancel={() => setDragging(false)}
            onKeyDown={onGripKey}
          >
            <title>{t('measurement_columns_grip_title')}</title>
            <rect x={20} y={toY(level) - 8} width={GUTTER - 22} height={16} rx={8} fill={COLORS.filterLine} />
            <text x={20 + (GUTTER - 22) / 2} y={toY(level) + 3.5} textAnchor="middle" fontSize={9.5} fontWeight={600} fill="#fff">
              {Math.round(level)}
            </text>
          </g>
        </svg>

        <div className="sensor-columns-scroll-wrap">
          <div
            ref={scrollerRef}
            className="sensor-columns-scroller"
            tabIndex={0}
            role="group"
            aria-label={t('plot_help_by_sensor_title')}
            data-testid={childTestId(testId, 'scroller')}
          >
            <svg
              width={plotWidth}
              height={SVG_H}
              className="sensor-columns-plot"
              onPointerMove={(event) => setHovered(sensorAt(event))}
              onPointerLeave={() => setHovered(null)}
              onClick={(event) => {
                const box = event.currentTarget.getBoundingClientRect();
                const sensor = shown[Math.floor((event.clientX - box.left) / column)];
                if (sensor != null) {
                  onToggleSensor(sensor);
                }
              }}
              data-testid={childTestId(testId, 'plot')}
            >
              {ticks.map((tick) => (
                <line key={tick} x1={0} x2={plotWidth} y1={toY(tick)} y2={toY(tick)} stroke={COLORS.grid} />
              ))}
              {/* Per column: its threshold area and, followed, its colour - behind everything. */}
              {shown.map((sensor, index) => {
                const own = thresholdOf(sensor);
                const isSelected = selected.includes(sensor);
                return (
                  <g key={`bg-${sensor}`}>
                    {own != null && (
                      <rect x={index * column} y={toY(own)} width={column} height={toY(-own) - toY(own)} fill={COLORS.threshold} />
                    )}
                    {isSelected && (
                      <rect
                        x={index * column}
                        y={PLOT_TOP}
                        width={column}
                        height={PLOT_H}
                        fill={colorOf(sensor)}
                        opacity={0.16}
                        {...repeatedTestId(`${testId}-selected`, sensor)}
                      />
                    )}
                    {hovered === sensor && (
                      <rect x={index * column} y={PLOT_TOP} width={column} height={PLOT_H} fill={COLORS.hover} />
                    )}
                  </g>
                );
              })}
              {/* The "hide below" level: what lies inside ±it is too quiet to show. */}
              {level > 0 && (
                <g data-testid={childTestId(testId, 'filter-band')}>
                  <rect x={0} y={toY(level)} width={plotWidth} height={toY(-level) - toY(level)} fill={COLORS.filter} />
                  {[level, -level].map((value) => (
                    <line
                      key={value}
                      x1={0}
                      x2={plotWidth}
                      y1={toY(value)}
                      y2={toY(value)}
                      stroke={COLORS.filterLine}
                      strokeDasharray="4 3"
                    />
                  ))}
                </g>
              )}
              <line x1={0} x2={plotWidth} y1={toY(0)} y2={toY(0)} stroke={COLORS.baseline} strokeWidth={1.5} />

              {shown.map((sensor, index) => {
                const x = index * column;
                const off = disabledSensors?.has(sensor) ?? false;
                const at = (fraction: number) => x + fraction * column;
                const colored = (color: string) => (off ? DISABLED_SENSOR_FILL : color);
                return (
                  <g
                    key={sensor}
                    data-sensor={sensor + 1}
                    data-disabled={off || undefined}
                    {...repeatedTestId(`${testId}-column`, sensor + 1)}
                  >
                    {slots.spread && (() => {
                      const [from, to] = slots.spread;
                      const middle = at((from + to) / 2);
                      const capHalf = Math.max(1.5, ((to - from) * column) / 4);
                      return (
                        <g data-part="spread">
                          {parts.has('minmax') && (
                            <g data-part="minmax" stroke={off ? DISABLED_SENSOR_STROKE : COLORS.whisker} strokeWidth={1.5}>
                              <line x1={middle} x2={middle} y1={toY(spread.max[sensor])} y2={toY(spread.min[sensor])} />
                              <line x1={middle - capHalf} x2={middle + capHalf} y1={toY(spread.max[sensor])} y2={toY(spread.max[sensor])} />
                              <line x1={middle - capHalf} x2={middle + capHalf} y1={toY(spread.min[sensor])} y2={toY(spread.min[sensor])} />
                            </g>
                          )}
                          {parts.has('sigma') && (
                            <rect
                              data-part="sigma"
                              x={at(from)}
                              y={toY(spread.upper[sensor])}
                              width={Math.max(1, (to - from) * column)}
                              height={Math.max(1, toY(spread.lower[sensor]) - toY(spread.upper[sensor]))}
                              rx={radius}
                              fill={colored(COLORS.sigma)}
                            />
                          )}
                          {parts.has('mean') && (
                            <line
                              data-part="mean"
                              x1={at(from)}
                              x2={at(to)}
                              y1={toY(spread.mean[sensor])}
                              y2={toY(spread.mean[sensor])}
                              stroke={off ? DISABLED_SENSOR_STROKE : COLORS.mean}
                              strokeWidth={2.5}
                            />
                          )}
                        </g>
                      );
                    })()}
                    {slots.bars.map(({ key, from, to }) => {
                      const value = valueOf(key, sensor);
                      if (value == null) {
                        return null;
                      }
                      const mask = key === 'sum' || !masks || !parts.has('masks') ? null : masks[key][sensor];
                      const top = Math.min(toY(value), toY(0));
                      const barWidth = Math.max(1, (to - from) * column);
                      return (
                        <g key={key}>
                          <rect
                            data-part={key}
                            x={at(from)}
                            y={top}
                            width={barWidth}
                            height={Math.max(1, Math.abs(toY(value) - toY(0)))}
                            rx={Math.min(radius, barWidth / 3)}
                            fill={colored(COLORS[key])}
                          />
                          {mask != null && (
                            <rect
                              data-part={`mask-${key}`}
                              x={at(from)}
                              y={Math.min(toY(mask), toY(0))}
                              width={barWidth}
                              height={Math.max(1, Math.abs(toY(mask) - toY(0)))}
                              fill="none"
                              stroke={COLORS[key]}
                              strokeWidth={1.2}
                              strokeDasharray="3 2"
                            />
                          )}
                        </g>
                      );
                    })}
                    {index % every === 0 && (
                      <text
                        x={x + column / 2}
                        y={SVG_H - 8}
                        textAnchor="middle"
                        fontSize={10}
                        fill={off ? DISABLED_SENSOR_STROKE : COLORS.muted}
                        textDecoration={off ? 'line-through' : undefined}
                      >
                        {sensor + 1}
                      </text>
                    )}
                  </g>
                );
              })}
            </svg>
          </div>
          <WheelZoomHint visible={wheelHint} radius={0} testId={childTestId(testId, 'wheel-hint')} />
          {tooltip && (
            <MeasurementCompareTooltip
              tooltip={tooltip}
              activeKey={null}
              testId={childTestId(testId, 'tooltip')}
              style={{ top: TOOLTIP_INSET, right: TOOLTIP_INSET }}
            />
          )}
        </div>
      </div>
      <div className="sensor-columns-status" data-testid={childTestId(testId, 'status')}>
        {hovered != null
          ? t(selected.includes(hovered) ? 'measurement_compare_sensor_click_remove' : 'measurement_compare_sensor_click_add', {
              sensor: hovered + 1,
            })
          : t('measurement_columns_shown', { shown: shown.length, total: count })}
        {hovered != null && peakOf(spread, hovered) < level && ` · ${t('measurement_columns_kept_selected')}`}
      </div>
    </div>
  );
};

export default SensorColumnsPlot;
