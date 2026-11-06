import {
  type KeyboardEvent,
  type PointerEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { gridValuesOf, labelEveryOf } from './thresholdMixer';
import { paintMask } from './noiseProfiles';

type Masks = { mask_e: number[]; mask_w: number[] };

type NoiseProfilePlotProps = {
  mask_e: number[];
  mask_w: number[];
  /** Called once a drag (or a key press) ends - the plots reclean only then. */
  onChange: (masks: Masks) => void;
  /** A raw measurement's EP / WP, drawn faintly for orientation. */
  reference?: { ep: number[]; wp: number[] } | null;
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

type Series = 'ep' | 'wp' | 'both';
type Drag = { series: Series; index: number; value: number };

const KEY: Record<Exclude<Series, 'both'>, keyof Masks> = { ep: 'mask_e', wp: 'mask_w' };

/**
 * A Störungsprofil as a plot: per sensor the EP mask (red) and the WP mask
 * (blue). Press on a sensor near a line and drag up / down - across sensors
 * it paints them; Shift moves EP and WP together. ↑/↓ nudge the last touched
 * value (Shift: by 10), ←/→ step to the next sensor.
 */
const NoiseProfilePlot = ({ mask_e, mask_w, onChange, reference = null }: NoiseProfilePlotProps) => {
  const { t } = useTranslation();
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(800);
  // The masks while dragging - committed with the drag's end.
  const [live, setLive] = useState<Masks | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [frozenScale, setFrozenScale] = useState<number | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const [focus, setFocus] = useState<{ series: Series; index: number } | null>(null);

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
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // jsdom / old browsers: the drag still works while over the plot.
    }
  };

  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const { index, y } = pointerAt(event);
    if (!drag) {
      setHovered(index);
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
      const index = Math.min(sensors - 1, Math.max(0, focus.index + (event.key === 'ArrowLeft' ? -1 : 1)));
      setFocus({ ...focus, index });
      setHovered(index);
      return;
    }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
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

  return (
    <div data-testid="noise-profile-plot">
      <div className="d-flex flex-wrap align-items-center gap-3 mb-1 small text-muted">
        <span className="d-inline-flex align-items-center gap-1">
          <span style={{ width: 16, height: 3, background: EP_COLOR }} /> {t('noise_profile_mask_ep')}
        </span>
        <span className="d-inline-flex align-items-center gap-1">
          <span style={{ width: 16, height: 3, background: WP_COLOR }} /> {t('noise_profile_mask_wp')}
        </span>
        {reference && (
          <span className="d-inline-flex align-items-center gap-1">
            <span style={{ width: 16, height: 0, borderTop: `2px dotted ${MUTED}` }} /> {t('noise_profile_plot_reference')}
          </span>
        )}
        <span className="ms-auto" data-testid="noise-profile-plot-readout" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {shown != null
            ? t('noise_profile_plot_readout', {
                sensor: shown + 1,
                ep: masks.mask_e[shown] ?? 0,
                wp: masks.mask_w[shown] ?? 0,
              })
            : t('noise_profile_plot_usage')}
        </span>
      </div>
      <div className="d-flex">
        <svg width={GUTTER} height={SVG_H} style={{ flexShrink: 0 }} aria-hidden="true">
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
          onKeyDown={onKeyDown}
          style={{ flex: 1, minWidth: 0, overflowX: 'auto', overflowY: 'hidden', outline: 'none' }}
        >
          <svg
            width={plotWidth}
            height={SVG_H}
            style={{ display: 'block', touchAction: 'none', userSelect: 'none', cursor: drag ? 'ns-resize' : 'crosshair' }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onPointerLeave={() => !drag && setHovered(null)}
            data-testid="noise-profile-plot-area"
          >
            {gridValues.map((value) => (
              <line key={value} x1={0} x2={plotWidth} y1={toY(value)} y2={toY(value)} stroke={GRID} />
            ))}
            <line x1={0} x2={plotWidth} y1={PLOT_TOP + PLOT_H} y2={PLOT_TOP + PLOT_H} stroke="var(--progeo-track)" />
            {shown != null && (
              <rect x={shown * column} y={PLOT_TOP} width={column} height={PLOT_H} fill="rgba(11, 54, 89, .06)" />
            )}
            {reference && (
              <>
                <path d={path(reference.ep)} fill="none" stroke={EP_COLOR} strokeOpacity={0.35} strokeDasharray="2 3" />
                <path d={path(reference.wp)} fill="none" stroke={WP_COLOR} strokeOpacity={0.35} strokeDasharray="2 3" />
              </>
            )}
            <path d={path(masks.mask_e)} fill="none" stroke={EP_COLOR} strokeWidth={2} />
            <path d={path(masks.mask_w)} fill="none" stroke={WP_COLOR} strokeWidth={2} />
            {column >= POINT_COLUMN &&
              (['mask_e', 'mask_w'] as const).map((key) =>
                masks[key].map((value, index) => (
                  <circle
                    key={`${key}-${index}`}
                    cx={xOf(index)}
                    cy={toY(value)}
                    r={Math.min(4, column / 4)}
                    fill={key === 'mask_e' ? EP_COLOR : WP_COLOR}
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
      </div>
    </div>
  );
};

export default NoiseProfilePlot;
