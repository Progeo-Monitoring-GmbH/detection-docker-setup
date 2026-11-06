import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { Button } from 'react-bootstrap';
import { PauseFill, PlayFill } from 'react-bootstrap-icons';
import { useTranslation } from 'react-i18next';
import { formatDate } from '../../main/dateFormat';
import { announceKey } from '../ui/KeyHints';
import TimeAxis from './TimeAxis';
import { frameTimeAt } from './timeTicks';
import './FrameSlider.css';

type FrameSliderProps = {
  id: string;
  /** Unix seconds of the frames, oldest first. */
  timestamps: number[];
  index: number;
  onChange: (index: number) => void;
  disabled?: boolean;
  /** Alarm periods, marked on the slider - a click on one jumps to its start. */
  alarms?: AlarmSpan[];
  /** Whether the space bar toggles the animation - off for a second slider on the page. */
  playKey?: boolean;
  /** The time span (ms) shown elsewhere, e.g. a chart's zoomed time axis - a band on the track. */
  visibleRange?: { from: number; to: number } | null;
  /** Controls shown in the slider's top row, e.g. the period it covers. */
  toolbar?: ReactNode;
  /**
   * A selected time span (ms) - a band in a strip below the track: dragged
   * it moves, its edges resize it, dragging on the empty strip makes a new
   * one. Without `onSelectionChange` there is no strip.
   */
  selection?: TimeSpan | null;
  onSelectionChange?: (selection: TimeSpan) => void;
  /** The selection band's tooltip, e.g. what it is for. */
  selectionLabel?: string;
};

type TimeSpan = { from: number; to: number };

/** An alarm's period (ms); `to` is now while it is still active. */
export type AlarmSpan = { key: string; from: number; to: number; label: string };

/** Where an alarm sits on a slider over `timestamps` ({left, right}, 0..1),
 * cut to the frames; null when it lies outside of them. */
export const alarmPosition = (timestamps: number[], span: AlarmSpan) => {
  const count = timestamps.length;
  if (count < 2) {
    return null;
  }
  const first = timestamps[0] * 1000;
  const last = timestamps[count - 1] * 1000;
  if (span.to < first || span.from > last) {
    return null;
  }
  const at = (ms: number) => framePosition(timestamps, Math.min(Math.max(ms, first), last));
  return { left: at(span.from), right: at(span.to) };
};

/** The frame that holds `ms`: the last one starting at or before it, if it
 * still covers it (one step: the frames' smallest spacing) - after a gap
 * without data the next one. */
export const frameAt = (timestamps: number[], ms: number) => {
  const seconds = ms / 1000;
  const next = timestamps.findIndex((start) => start >= seconds);
  if (next === 0) {
    return 0;
  }
  const previous = (next < 0 ? timestamps.length : next) - 1;
  if (previous < 0) {
    return 0;
  }
  const step = timestamps.reduce(
    (smallest, start, index) => (index > 0 ? Math.min(smallest, start - timestamps[index - 1]) : smallest),
    Number.POSITIVE_INFINITY,
  );
  return seconds - timestamps[previous] < step || next < 0 ? previous : next;
};

/** Narrowest mark (px): an alarm within one frame stays visible. */
const MIN_ALARM_WIDTH = 4;

/** The alarm tooltip above its mark's centre (0..1 of the track) - kept inside the slider at the edges. */
const tooltipPlace = (center: number): CSSProperties => ({
  left: `calc(0.5rem + (100% - 1rem) * ${center})`,
  transform: center < 0.15 ? 'translateX(-8px)' : center > 0.85 ? 'translateX(calc(-100% + 8px))' : 'translateX(-50%)',
});

/** Time per frame while the animation runs. */
export const ANIMATION_FRAME_MS = 200;

/**
 * Where a moment sits on a slider over the frames `timestamps` (0..1): frames
 * without data are left out, so the positions are not evenly spaced in time
 * - a mark between two frames is placed between their positions.
 */
export const framePosition = (timestamps: number[], ms: number) => {
  const count = timestamps.length;
  if (count < 2) {
    return 0;
  }
  const seconds = ms / 1000;
  if (seconds <= timestamps[0]) {
    return seconds === timestamps[0] ? 0 : Number.NaN;
  }
  if (seconds >= timestamps[count - 1]) {
    return seconds === timestamps[count - 1] ? 1 : Number.NaN;
  }
  let low = 0;
  let high = count - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (timestamps[middle] <= seconds) {
      low = middle;
    } else {
      high = middle;
    }
  }
  const part = (seconds - timestamps[low]) / (timestamps[high] - timestamps[low]);
  return (low + part) / (count - 1);
};

/** Keys typed into these go to them, not to the animation. */
const typesText = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
    return true;
  }
  return target instanceof HTMLInputElement && target.type !== 'range' && target.type !== 'checkbox';
};

/** The space bar toggles the animation - unless the user is typing, or a
 * button or link has the focus (space presses it; this one toggles via its
 * click). */
const isPlayToggleKey = (event: KeyboardEvent) =>
  (event.code === 'Space' || event.key === ' ') &&
  !event.repeat &&
  !event.ctrlKey &&
  !event.altKey &&
  !event.metaKey &&
  !typesText(event.target) &&
  !(event.target instanceof HTMLButtonElement || event.target instanceof HTMLAnchorElement);

/**
 * Animation over `count` frames: `toggle` starts it - from the start again
 * when it is at the end - and stops it; it stops by itself at the last frame
 * and whenever it can't play. The space bar toggles it too.
 */
const useFramePlayback = ({
  count,
  index,
  onChange,
  canPlay,
  playKey,
}: {
  count: number;
  index: number;
  onChange: (index: number) => void;
  canPlay: boolean;
  playKey: boolean;
}) => {
  const [playing, setPlaying] = useState(false);
  // The interval and the key handler read the latest values.
  const latest = useRef({ playing, index, onChange });
  useLayoutEffect(() => {
    latest.current = { playing, index, onChange };
  });

  const toggle = useCallback(() => {
    if (latest.current.playing) {
      setPlaying(false);
      return;
    }
    if (latest.current.index >= count - 1) {
      latest.current.onChange(0); // at the end: play from the start
    }
    setPlaying(true);
  }, [count]);

  useEffect(() => {
    if (!playing) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      const next = latest.current.index + 1;
      if (next >= count) {
        setPlaying(false);
        return;
      }
      latest.current.index = next; // the next tick may come before the re-render
      latest.current.onChange(next);
      if (next === count - 1) {
        setPlaying(false);
      }
    }, ANIMATION_FRAME_MS);
    return () => window.clearInterval(timer);
  }, [playing, count]);

  // Stops with the export (disabled) or when there's nothing to play.
  useEffect(() => {
    if (!canPlay) {
      setPlaying(false);
    }
  }, [canPlay]);

  useEffect(() => {
    if (!canPlay || !playKey) {
      return undefined;
    }
    const onKey = (event: KeyboardEvent) => {
      if (isPlayToggleKey(event)) {
        event.preventDefault(); // no page scroll
        toggle();
        announceKey('play');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canPlay, playKey, toggle]);

  return { playing, toggle };
};

/** A selection band dragged on the strip: moved, resized at one edge, or drawn new. */
type SelectionDrag = {
  mode: 'move' | 'start' | 'end' | 'create';
  /** The pointer's start (px) and the band's (0..1) when the drag began. */
  startX: number;
  left: number;
  right: number;
};

/**
 * The band (0..1 of the strip) after dragging it by `delta` (0..1): moved
 * whole and kept inside, or one edge moved - never closer than `minWidth`
 * to the other. 'create' spans from where it started to the pointer.
 */
export const draggedSelection = (
  drag: Pick<SelectionDrag, 'mode' | 'left' | 'right'>,
  delta: number,
  minWidth: number,
): { left: number; right: number } => {
  const clamp = (value: number) => Math.min(Math.max(value, 0), 1);
  if (drag.mode === 'move') {
    const shift = Math.min(Math.max(delta, -drag.left), 1 - drag.right);
    return { left: drag.left + shift, right: drag.right + shift };
  }
  if (drag.mode === 'start') {
    return { left: Math.min(clamp(drag.left + delta), drag.right - minWidth), right: drag.right };
  }
  if (drag.mode === 'end') {
    return { left: drag.left, right: Math.max(clamp(drag.right + delta), drag.left + minWidth) };
  }
  const end = clamp(drag.left + delta);
  return { left: Math.min(drag.left, end), right: Math.max(drag.left, end) };
};

/**
 * The frame of the heatmap / plan: "3/168: date" above a slider over the
 * frames, evenly spread time labels below it. "Start Animation" (or the space bar)
 * steps through the frames - from the start again when it is at the end -
 * and stops at the last one.
 */
const FrameSlider = ({
  id,
  timestamps,
  index,
  onChange,
  disabled = false,
  alarms = [],
  playKey = true,
  visibleRange = null,
  toolbar = null,
  selection = null,
  onSelectionChange,
  selectionLabel,
}: FrameSliderProps) => {
  const { t } = useTranslation();
  const count = timestamps.length;
  const timeAt = useCallback((fraction: number) => frameTimeAt(timestamps, fraction), [timestamps]);
  const canPlay = count > 1 && !disabled;
  const { playing, toggle } = useFramePlayback({ count, index, onChange, canPlay, playKey });

  const label = playing ? t('heatmap_animation_stop') : t('heatmap_animation_start');
  const marks = alarms
    .map((alarm) => ({ alarm, at: alarmPosition(timestamps, alarm) }))
    .filter((mark): mark is { alarm: AlarmSpan; at: { left: number; right: number } } => mark.at != null);
  const visibleAt = visibleRange
    ? alarmPosition(timestamps, { key: 'visible', label: '', ...visibleRange })
    : null;
  // The selection while it is dragged (0..1) - reported when it is let go.
  const stripRef = useRef<HTMLDivElement | null>(null);
  const [selectionDrag, setSelectionDrag] = useState<SelectionDrag | null>(null);
  const [draggedAt, setDraggedAt] = useState<{ left: number; right: number } | null>(null);
  const selectionAt =
    draggedAt ?? (selection ? alarmPosition(timestamps, { key: 'selection', label: '', ...selection }) : null);
  // The alarm under the pointer (or the focused jump) - its tooltip.
  const alarmLayerRef = useRef<HTMLDivElement | null>(null);
  const [hoveredAlarm, setHoveredAlarm] = useState<string | null>(null);
  const hoveredMark = marks.find(({ alarm }) => alarm.key === hoveredAlarm) ?? null;
  const onBodyMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const layer = alarmLayerRef.current?.getBoundingClientRect();
    if (!layer || layer.width <= 0) {
      return;
    }
    const fraction = (event.clientX - layer.left) / layer.width;
    // A narrow mark is drawn MIN_ALARM_WIDTH wide - it is hovered as wide.
    const slack = MIN_ALARM_WIDTH / 2 / layer.width;
    const hit = [...marks].reverse().find(({ at }) => fraction >= at.left - slack && fraction <= at.right + slack);
    setHoveredAlarm(hit?.alarm.key ?? null);
  };
  const minSelection = count > 1 ? 1 / (count - 1) : 1;
  const spanOf = (at: { left: number; right: number }): TimeSpan => ({ from: timeAt(at.left), to: timeAt(at.right) });
  const stripFraction = (clientX: number) => {
    const rect = stripRef.current?.getBoundingClientRect();
    return rect && rect.width > 0 ? Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1) : 0;
  };
  const startSelectionDrag = (event: ReactPointerEvent<HTMLElement>, mode: SelectionDrag['mode']) => {
    if (!onSelectionChange || count < 2 || disabled) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const at = mode === 'create' ? null : selectionAt;
    const start = stripFraction(event.clientX);
    setSelectionDrag({ mode: at ? mode : 'create', startX: event.clientX, left: at?.left ?? start, right: at?.right ?? start });
    setDraggedAt(at ?? { left: start, right: start });
    try {
      stripRef.current?.setPointerCapture(event.pointerId);
    } catch {
      // jsdom / old browsers: the drag still works while over the strip.
    }
  };
  const moveSelectionDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!selectionDrag) {
      return;
    }
    const width = stripRef.current?.getBoundingClientRect().width || 1;
    setDraggedAt(draggedSelection(selectionDrag, (event.clientX - selectionDrag.startX) / width, minSelection));
  };
  const endSelectionDrag = () => {
    // A mere click on the empty strip draws nothing.
    if (selectionDrag && draggedAt && draggedAt.right - draggedAt.left >= minSelection / 2) {
      onSelectionChange?.(spanOf(draggedAt));
    }
    setSelectionDrag(null);
    setDraggedAt(null);
  };
  // ←/→ move the focused band by a frame, Shift + ←/→ its end.
  const onSelectionKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!selectionAt || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) {
      return;
    }
    event.preventDefault();
    const delta = (event.key === 'ArrowLeft' ? -1 : 1) * minSelection;
    onSelectionChange?.(
      spanOf(draggedSelection({ mode: event.shiftKey ? 'end' : 'move', ...selectionAt }, delta, minSelection)),
    );
  };
  const markStyle = (at: { left: number; right: number }) => ({
    left: `${at.left * 100}%`,
    width: `max(${(at.right - at.left) * 100}%, ${MIN_ALARM_WIDTH}px)`,
  });

  return (
    <div className="pb-2 pt-3" style={{ minWidth: 200 }}>
      <div className="d-flex flex-wrap align-items-center gap-2">
        <Button
          size="sm"
          variant={playing ? 'primary' : 'outline-primary'}
          onClick={toggle}
          disabled={!canPlay}
          aria-pressed={playing}
          title={playKey ? `${label} (${t('heatmap_animation_key')})` : label}
          className="d-inline-flex align-items-center gap-1 py-0"
          style={{ borderRadius: 'var(--progeo-radius-pill)', paddingInline: 12, fontSize: 12.5, fontWeight: 500 }}
        >
          {playing ? <PauseFill /> : <PlayFill />}
          {label}
        </Button>
        <label htmlFor={id} className="form-label small text-muted mb-0">
          {count ? `${index + 1}/${count}` : 'Timestamp'}
        </label>
        {toolbar}
        {count > 0 && (
          // The frame's time, large - readable at a glance while it plays.
          <div
            className="ms-auto d-flex align-items-baseline gap-2 text-nowrap"
            style={{ fontVariantNumeric: 'tabular-nums', lineHeight: 1.1 }}
          >
            <span className="fw-semibold" style={{ fontSize: '2.25rem' }}>
              {formatDate(timestamps[index] * 1000, 'time')}
            </span>
            <span className="text-muted" style={{ fontSize: '1.1rem' }}>
              {formatDate(timestamps[index] * 1000, 'weekdayDate')}
            </span>
          </div>
        )}
      </div>
      {/* The slider's body: the alarms as a transparent layer behind
          everything (track, selection, time labels stay readable over them);
          hovering one tells it, a click below the track jumps to its start. */}
      <div
        className="frame-slider__body"
        onPointerMove={marks.length ? onBodyMove : undefined}
        onPointerLeave={() => setHoveredAlarm(null)}
      >
        {marks.length > 0 && (
          <div ref={alarmLayerRef} className="frame-slider__alarm-layer" aria-hidden="true">
            {marks.map(({ alarm, at }) => (
              <span
                key={alarm.key}
                className={`frame-slider__alarm${alarm.key === hoveredAlarm ? ' frame-slider__alarm--hovered' : ''}`}
                style={markStyle(at)}
              />
            ))}
          </div>
        )}
      <div className="frame-slider__layer">
        <input
          id={id}
          type="range"
          className="form-range d-block frame-slider__input"
          min={0}
          max={Math.max(count - 1, 0)}
          step={1}
          value={index}
          // The played part of the track (FrameSlider.css).
          style={{ '--fill-ratio': count > 1 ? index / (count - 1) : 0 } as CSSProperties}
          onChange={(event) => onChange(Number(event.target.value))}
          disabled={disabled}
        />
        {visibleAt && (
          <div className="frame-slider__visible-layer" aria-hidden="true">
            <span
              className="frame-slider__visible"
              style={{
                left: `${visibleAt.left * 100}%`,
                width: `${(visibleAt.right - visibleAt.left) * 100}%`,
              }}
            />
          </div>
        )}
        {selectionAt && (
          <div className="frame-slider__visible-layer" aria-hidden="true">
            <span
              className="frame-slider__selection-shade"
              style={{
                left: `${selectionAt.left * 100}%`,
                width: `${(selectionAt.right - selectionAt.left) * 100}%`,
              }}
            />
          </div>
        )}
      </div>
      {onSelectionChange && count > 1 && (
        // The selection: a band to drag (move) with grips at its edges
        // (resize); on the empty strip a drag draws a new one.
        <div
          ref={stripRef}
          className="frame-slider__selection-strip"
          data-testid="frame-slider-selection-strip"
          title={selectionAt ? undefined : selectionLabel}
          onPointerDown={(event) => startSelectionDrag(event, 'create')}
          onPointerMove={moveSelectionDrag}
          onPointerUp={endSelectionDrag}
          onPointerCancel={endSelectionDrag}
        >
          {selectionAt && (
            <div
              role="slider"
              tabIndex={0}
              aria-label={selectionLabel}
              aria-valuetext={
                selection ? `${formatDate(selection.from, 'dateTime')} - ${formatDate(selection.to, 'dateTime')}` : undefined
              }
              className={`frame-slider__selection${selectionDrag ? ' frame-slider__selection--dragging' : ''}`}
              data-testid="frame-slider-selection"
              title={selectionLabel}
              style={{ left: `${selectionAt.left * 100}%`, width: `${(selectionAt.right - selectionAt.left) * 100}%` }}
              onPointerDown={(event) => startSelectionDrag(event, 'move')}
              onKeyDown={onSelectionKey}
            >
              <span
                className="frame-slider__selection-grip frame-slider__selection-grip--start"
                data-testid="frame-slider-selection-start"
                onPointerDown={(event) => startSelectionDrag(event, 'start')}
              />
              <span
                className="frame-slider__selection-grip frame-slider__selection-grip--end"
                data-testid="frame-slider-selection-end"
                onPointerDown={(event) => startSelectionDrag(event, 'end')}
              />
            </div>
          )}
        </div>
      )}
      {count > 1 && (
        // The thumb's centre travels half a thumb (1 rem) inside the input.
        <div className="frame-slider__layer" style={{ margin: '-4px 0.5rem 0' }}>
          <TimeAxis from={timestamps[0] * 1000} to={timestamps[count - 1] * 1000} timeAt={timeAt} />
          {marks.length > 0 && (
            // Under the track the alarms are buttons: a click jumps to their
            // start. Transparent - the time labels show through.
            <div className="frame-slider__alarm-jumps">
              {marks.map(({ alarm, at }) => (
                <button
                  key={alarm.key}
                  type="button"
                  className="frame-slider__alarm-jump"
                  style={markStyle(at)}
                  aria-label={alarm.label}
                  onClick={() => onChange(frameAt(timestamps, alarm.from))}
                  onFocus={() => setHoveredAlarm(alarm.key)}
                  onBlur={() => setHoveredAlarm(null)}
                />
              ))}
            </div>
          )}
        </div>
      )}
      {hoveredMark && (
        <div
          className="frame-slider__alarm-tooltip"
          role="tooltip"
          data-testid="frame-slider-alarm-tooltip"
          style={tooltipPlace((hoveredMark.at.left + hoveredMark.at.right) / 2)}
        >
          <div className="fw-semibold">{hoveredMark.alarm.label}</div>
          <div style={{ fontVariantNumeric: 'tabular-nums' }}>
            {formatDate(hoveredMark.alarm.from, 'dateTime')} – {formatDate(hoveredMark.alarm.to, 'dateTime')}
          </div>
          <div className="frame-slider__alarm-tooltip-hint">{t('frame_slider_alarm_jump')}</div>
        </div>
      )}
      </div>
    </div>
  );
};

export default FrameSlider;
