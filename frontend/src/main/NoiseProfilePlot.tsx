import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import MeasurementCompareTooltip, {
  type CompareTooltipData,
  TOOLTIP_WIDTH,
} from '../components/device/MeasurementCompareTooltip';
import { announceKey, type KeyHint } from '../components/ui/KeyHints';
import UsageHelp from '../components/ui/UsageHelp';
import PlotHelp from '../components/ui/PlotHelp';
import { gridValuesOf, labelEveryOf } from './thresholdMixer';
import { paintMask } from './noiseProfiles';
import { childTestId } from '../testIds';
import './NoiseProfile.css';

type Masks = { mask_e: number[]; mask_w: number[] };

type NoiseProfilePlotProps = {
  mask_e: number[];
  mask_w: number[];
  /** Called once a drag (or a key press) ends - the plots reclean only then. */
  onChange: (masks: Masks) => void;
  /** A raw measurement's EP / WP, drawn dashed for orientation. */
  reference?: { ep: number[]; wp: number[] } | null;
  /** Keys the surrounding editor handles too (Strg + Z) - listed with the plot's. */
  extraKeyHints?: KeyHint[];
  /** data-testid of the plot (default "noise-profile-plot"); its area is "<testId>-area". */
  testId?: string;
};

const EP_COLOR = '#d62728';
const WP_COLOR = '#1f5fbf';
const MUTED = '#8B8383';
const GRID = 'rgba(11, 54, 89, .08)';

const PLOT_TOP = 10;
const PLOT_H = 220;
const AXIS_H = 22;
const SVG_H = PLOT_TOP + PLOT_H + AXIS_H;
const GUTTER = 48;
/** Columns never get narrower (then the plot scrolls). */
const MIN_COLUMN = 4;
/** Points are drawn from this column width on. */
const POINT_COLUMN = 8;
/** How close (px) the cursor must be to a line to highlight it - as in the measurement plot. */
const HIGHLIGHT_DISTANCE_PX = 12;
/** The tooltip's distance (px) from the plot's corner, and how near the cursor may come before it flips. */
const TOOLTIP_INSET_PX = 8;
const TOOLTIP_FLIP_DISTANCE_PX = 24;

/** The line widths: masks, the raw measurement - a highlighted line is wider by this. */
const MASK_WIDTH = 2;
const REFERENCE_WIDTH = 2.5;
const HIGHLIGHT_EXTRA = 2;
const FADED = 0.3;

type Series = 'ep' | 'wp' | 'both';
type Drag = { series: Series; index: number; value: number };
/** A line of the plot: the masks, or the raw measurement (both its lines). */
type Line = 'ep' | 'wp' | 'ref';

const KEY: Record<Exclude<Series, 'both'>, keyof Masks> = { ep: 'mask_e', wp: 'mask_w' };

/**
 * A Störungsprofil as a plot: per sensor the EP mask (red) and the WP mask
 * (blue), a raw measurement dashed behind them. Press on a sensor near a line
 * and drag up / down - across sensors it paints them; Shift moves EP and WP
 * together. ↑/↓ nudge the last touched value (Shift: by 10), ←/→ step to the
 * next sensor. Hovering shows the sensor's values (tooltip, as in the
 * measurement plot) and highlights the nearest line - its legend entry too.
 */
const NoiseProfilePlot = ({
  mask_e,
  mask_w,
  onChange,
  reference = null,
  extraKeyHints = [],
  testId = 'noise-profile-plot',
}: NoiseProfilePlotProps) => {
  const { t } = useTranslation();
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(800);
  // The masks while dragging - committed with the drag's end.
  const [live, setLive] = useState<Masks | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [frozenScale, setFrozenScale] = useState<number | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const [focus, setFocus] = useState<{ series: Series; index: number } | null>(null);
  const [focused, setFocused] = useState(false);
  // The line under the cursor, or whose legend entry is hovered.
  const [highlighted, setHighlighted] = useState<Line | null>(null);
  const [legendHover, setLegendHover] = useState<Line | null>(null);
  // The tooltip flips to the left while the cursor is near its corner.
  const [tooltipLeft, setTooltipLeft] = useState(false);

  const masks = live ?? { mask_e, mask_w };
  const sensors = Math.max(masks.mask_e.length, masks.mask_w.length);

  useLayoutEffect(() => {
    const element = scrollerRef.current;
    if (!element || typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    const observer = new ResizeObserver(() => setWidth(element.clientWidth || 800));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const column = Math.max(MIN_COLUMN, width / Math.max(sensors, 1));
  const plotWidth = Math.max(width, column * sensors);
  const xOf = (index: number) => (index + 0.5) * column;

  const liveScale = useMemo(() => {
    const values = [...mask_e, ...mask_w, ...(reference?.ep ?? []), ...(reference?.wp ?? [])];
    return Math.max(10, ...values.filter((value) => Number.isFinite(value))) * 1.2;
  }, [mask_e, mask_w, reference]);
  // Fixed while dragging - it would move under the pointer.
  const scale = frozenScale ?? liveScale;
  const toY = (value: number) => PLOT_TOP + PLOT_H - (Math.min(Math.max(value, 0), scale) / scale) * PLOT_H;
  const valueAt = (y: number) => Math.max(0, Math.round(((PLOT_TOP + PLOT_H - y) / PLOT_H) * scale));

  const pointerAt = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const index = Math.min(sensors - 1, Math.max(0, Math.floor((event.clientX - rect.left) / column)));
    return { index, y: event.clientY - rect.top };
  };

  /** The line nearest to `y` at sensor `index` - within HIGHLIGHT_DISTANCE_PX. */
  const nearestLine = (index: number, y: number): Line | null => {
    const candidates: [Line, number | undefined][] = [
      ['ep', masks.mask_e[index]],
      ['wp', masks.mask_w[index]],
      ['ref', reference?.ep[index]],
      ['ref', reference?.wp[index]],
    ];
    let best: Line | null = null;
    let distance = HIGHLIGHT_DISTANCE_PX;
    candidates.forEach(([line, value]) => {
      if (value != null && Number.isFinite(value) && Math.abs(toY(value) - y) <= distance) {
        best = line;
        distance = Math.abs(toY(value) - y);
      }
    });
    return best;
  };

  /** Where the cursor is over the visible plot - for the tooltip's side. */
  const placeTooltip = (clientX: number, clientY: number) => {
    const box = wrapRef.current?.getBoundingClientRect();
    if (!box) {
      return;
    }
    const x = clientX - box.left;
    const y = clientY - box.top;
    const right = box.width - TOOLTIP_INSET_PX;
    setTooltipLeft(x >= right - TOOLTIP_WIDTH - TOOLTIP_FLIP_DISTANCE_PX && y <= PLOT_TOP + 120 + TOOLTIP_FLIP_DISTANCE_PX);
  };

  /** The masks with `series` painted from `from` to `to`. */
  const painted = (base: Masks, series: Series, from: number, to: number, fromValue: number, toValue: number) => {
    const next = { ...base };
    (series === 'both' ? (['ep', 'wp'] as const) : [series]).forEach((one) => {
      next[KEY[one]] = paintMask(base[KEY[one]], from, to, fromValue, toValue);
    });
    return next;
  };

  const onPointerDown = (event: PointerEvent<SVGSVGElement>) => {
    if (!sensors) {
      return;
    }
    event.preventDefault();
    scrollerRef.current?.focus({ preventScroll: true });
    const { index, y } = pointerAt(event);
    // The line nearer to the press - Shift: both.
    const ep = masks.mask_e[index] ?? 0;
    const wp = masks.mask_w[index] ?? 0;
    const series: Series = event.shiftKey ? 'both' : Math.abs(toY(ep) - y) <= Math.abs(toY(wp) - y) ? 'ep' : 'wp';
    const value = valueAt(y);
    setFrozenScale(liveScale);
    setLive(painted(masks, series, index, index, value, value));
    setDrag({ series, index, value });
    setFocus({ series, index });
    setHighlighted(series === 'both' ? null : series);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // jsdom / old browsers: the drag still works while over the plot.
    }
  };

  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const { index, y } = pointerAt(event);
    placeTooltip(event.clientX, event.clientY);
    if (!drag) {
      setHovered(index);
      setHighlighted(nearestLine(index, y));
      return;
    }
    const value = valueAt(y);
    setLive((current) => painted(current ?? masks, drag.series, drag.index, index, drag.value, value));
    setDrag({ ...drag, index, value });
    setFocus({ series: drag.series, index });
    setHovered(index);
  };

  const endDrag = () => {
    if (drag && live) {
      onChange(live);
    }
    setDrag(null);
    setLive(null);
    setFrozenScale(null);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!focus || !sensors) {
      return;
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      announceKey('plot-sensor');
      const index = Math.min(sensors - 1, Math.max(0, focus.index + (event.key === 'ArrowLeft' ? -1 : 1)));
      setFocus({ ...focus, index });
      setHovered(index);
      return;
    }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      announceKey('plot-value');
      const by = (event.shiftKey ? 10 : 1) * (event.key === 'ArrowUp' ? 1 : -1);
      const next = { ...masks };
      (focus.series === 'both' ? (['ep', 'wp'] as const) : [focus.series]).forEach((one) => {
        const value = (masks[KEY[one]][focus.index] ?? 0) + by;
        next[KEY[one]] = paintMask(masks[KEY[one]], focus.index, focus.index, value, value);
      });
      onChange(next);
    }
  };

  const path = (values: number[]) =>
    values.map((value, index) => `${index ? 'L' : 'M'}${xOf(index).toFixed(1)},${toY(value).toFixed(1)}`).join(' ');

  const gridValues = gridValuesOf(scale / 1.2).filter((value) => value <= scale);
  const every = labelEveryOf(column);
  const shown = hovered ?? focus?.index ?? null;
  // A hovered legend entry wins over the line under the cursor.
  const lit = legendHover ?? highlighted;
  const lineStyle = (line: Line, width: number) => ({
    strokeWidth: lit === line ? width + HIGHLIGHT_EXTRA : width,
    opacity: lit && lit !== line ? FADED : 1,
  });

  // The tooltip: the sensor's masks and the raw measurement, as in the
  // first measurement plot (fixed corner, the highlighted row bold).
  const tooltip: CompareTooltipData | null =
    hovered != null && !drag
      ? {
          title: t('noise_profile_plot_tooltip_title', { sensor: hovered + 1 }),
          subtitle: reference ? t('noise_profile_plot_tooltip_subtitle') : null,
          rows: [
            { key: 'ep', name: t('noise_profile_mask_ep'), value: String(masks.mask_e[hovered] ?? 0), color: EP_COLOR },
            { key: 'wp', name: t('noise_profile_mask_wp'), value: String(masks.mask_w[hovered] ?? 0), color: WP_COLOR },
            ...(reference
              ? [
                  {
                    key: 'ref',
                    name: `${t('noise_profile_plot_reference')} EP`,
                    value: String(reference.ep[hovered] ?? '–'),
                    color: EP_COLOR,
                  },
                  {
                    key: 'ref-wp',
                    name: `${t('noise_profile_plot_reference')} WP`,
                    value: String(reference.wp[hovered] ?? '–'),
                    color: WP_COLOR,
                  },
                ]
              : []),
          ],
        }
      : null;

  const legendEntry = (line: Line, swatch: ReactNode, label: string) => (
    <span
      className={`d-inline-flex align-items-center gap-1 noise-plot-legend-entry ${lit === line ? 'fw-semibold text-body' : ''}`}
      data-testid={`noise-profile-legend-${line}`}
      onMouseEnter={() => setLegendHover(line)}
      onMouseLeave={() => setLegendHover(null)}
    >
      {swatch} {label}
    </span>
  );

  const keyHints: KeyHint[] = [
    { keys: [t('key_drag')], label: t('key_hint_plot_drag') },
    { keys: ['Shift', t('key_drag')], label: t('key_hint_plot_both') },
    { id: 'plot-sensor', keys: ['← / →'], label: t('key_hint_plot_sensor') },
    { id: 'plot-value', keys: ['↑ / ↓'], label: t('key_hint_plot_value') },
    ...extraKeyHints,
  ];
  // What is useful right now - the usage help's first lines.
  const tips = !focused
    ? [t('usage_tip_plot_click')]
    : focus
      ? [
          t('usage_tip_plot_point', {
            sensor: focus.index + 1,
            series: focus.series === 'both' ? 'EP + WP' : focus.series.toUpperCase(),
          }),
        ]
      : [t('usage_tip_plot_pick')];

  return (
    <div data-testid={testId}>
      <div className="d-flex flex-wrap align-items-center gap-3 mb-2 small text-muted">
        {legendEntry('ep', <span className="noise-plot-swatch" style={{ background: EP_COLOR }} />, t('noise_profile_mask_ep'))}
        {legendEntry('wp', <span className="noise-plot-swatch" style={{ background: WP_COLOR }} />, t('noise_profile_mask_wp'))}
        {reference &&
          legendEntry(
            'ref',
            <span className="noise-plot-swatch noise-plot-swatch--dashed" style={{ borderTop: `3px dashed ${MUTED}` }} />,
            t('noise_profile_plot_reference'),
          )}
        <span className="ms-auto d-inline-flex align-items-center gap-2">
          <UsageHelp
            id="noise-profile-plot-usage"
            hints={keyHints}
            tips={tips}
            active={focused}
            inactiveNote={t('key_hints_plot_inactive')}
          />
          <PlotHelp topic="noise_profile" testId={childTestId(testId, 'help')} />
        </span>
      </div>
      <div ref={wrapRef} className="d-flex noise-plot-body">
        <svg width={GUTTER} height={SVG_H} className="noise-plot-gutter" aria-hidden="true">
          {gridValues.map((tick) => (
            <text key={tick} x={GUTTER - 6} y={toY(tick) + 3} textAnchor="end" fontSize={10} fill={MUTED}>
              {tick}
            </text>
          ))}
        </svg>
        <div
          ref={scrollerRef}
          tabIndex={0}
          role="group"
          aria-label={t('noise_profile_plot_label')}
          data-testid={childTestId(testId, 'scroller')}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          className={`noise-plot-scroller${focused ? ' noise-plot-scroller--focused' : ''}`}
        >
          <svg
            width={plotWidth}
            height={SVG_H}
            className={`noise-plot-area${drag ? ' noise-plot-area--dragging' : ''}`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onPointerLeave={() => {
              if (!drag) {
                setHovered(null);
                setHighlighted(null);
              }
            }}
            data-testid={childTestId(testId, 'area')}
          >
            {gridValues.map((value) => (
              <line key={value} x1={0} x2={plotWidth} y1={toY(value)} y2={toY(value)} stroke={GRID} />
            ))}
            <line x1={0} x2={plotWidth} y1={PLOT_TOP + PLOT_H} y2={PLOT_TOP + PLOT_H} stroke="var(--progeo-track)" />
            {shown != null && (
              <rect x={shown * column} y={PLOT_TOP} width={column} height={PLOT_H} fill="rgba(11, 54, 89, .06)" />
            )}
            {reference && (
              <g data-testid="noise-profile-reference" {...lineStyle('ref', REFERENCE_WIDTH)}>
                <path d={path(reference.ep)} fill="none" stroke={EP_COLOR} strokeOpacity={0.6} strokeDasharray="6 4" />
                <path d={path(reference.wp)} fill="none" stroke={WP_COLOR} strokeOpacity={0.6} strokeDasharray="6 4" />
              </g>
            )}
            <path
              d={path(masks.mask_e)}
              fill="none"
              stroke={EP_COLOR}
              data-testid="noise-profile-line-ep"
              {...lineStyle('ep', MASK_WIDTH)}
            />
            <path
              d={path(masks.mask_w)}
              fill="none"
              stroke={WP_COLOR}
              data-testid="noise-profile-line-wp"
              {...lineStyle('wp', MASK_WIDTH)}
            />
            {column >= POINT_COLUMN &&
              (['mask_e', 'mask_w'] as const).map((key) =>
                masks[key].map((value, index) => (
                  <circle
                    key={`${key}-${index}`}
                    cx={xOf(index)}
                    cy={toY(value)}
                    r={Math.min(4, column / 4)}
                    fill={key === 'mask_e' ? EP_COLOR : WP_COLOR}
                    opacity={lit && lit !== (key === 'mask_e' ? 'ep' : 'wp') ? FADED : 1}
                  />
                )),
              )}
            {Array.from({ length: sensors }, (_, index) =>
              index === 0 || (index + 1) % every === 0 ? (
                <text key={index} x={xOf(index)} y={SVG_H - 6} textAnchor="middle" fontSize={10} fill={MUTED}>
                  {index + 1}
                </text>
              ) : null,
            )}
          </svg>
        </div>
        {tooltip && (
          <MeasurementCompareTooltip
            tooltip={tooltip}
            testId={childTestId(testId, 'tooltip')}
            activeKey={lit === 'ref' ? 'ref' : lit}
            style={
              tooltipLeft
                ? { top: PLOT_TOP + TOOLTIP_INSET_PX, left: GUTTER + TOOLTIP_INSET_PX }
                : { top: PLOT_TOP + TOOLTIP_INSET_PX, right: TOOLTIP_INSET_PX }
            }
          />
        )}
      </div>
    </div>
  );
};

export default NoiseProfilePlot;
