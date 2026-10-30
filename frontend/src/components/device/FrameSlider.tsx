import { type CSSProperties, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button } from 'react-bootstrap';
import { PauseFill, PlayFill } from 'react-bootstrap-icons';
import { useTranslation } from 'react-i18next';
import { formatDate } from '../../main/dateFormat';
import TimeAxis from './TimeAxis';
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
};

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
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canPlay, playKey, toggle]);

  return { playing, toggle };
};

/**
 * The frame of the heatmap / plan: "3/168: date" above a slider over the
 * frames, calendar marks below it. "Start Animation" (or the space bar)
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
}: FrameSliderProps) => {
  const { t } = useTranslation();
  const count = timestamps.length;
  const position = useCallback((ms: number) => framePosition(timestamps, ms), [timestamps]);
  const canPlay = count > 1 && !disabled;
  const { playing, toggle } = useFramePlayback({ count, index, onChange, canPlay, playKey });

  const label = playing ? t('heatmap_animation_stop') : t('heatmap_animation_start');
  const marks = alarms
    .map((alarm) => ({ alarm, at: alarmPosition(timestamps, alarm) }))
    .filter((mark): mark is { alarm: AlarmSpan; at: { left: number; right: number } } => mark.at != null);
  const visibleAt = visibleRange
    ? alarmPosition(timestamps, { key: 'visible', label: '', ...visibleRange })
    : null;
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
      <div style={{ position: 'relative' }}>
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
        {marks.length > 0 && (
          // Over the track, in the thumb's travel (1 rem inside the input);
          // the slider stays usable through it.
          <div className="frame-slider__alarms" aria-hidden="true">
            {marks.map(({ alarm, at }) => (
              <span key={alarm.key} className="frame-slider__alarm" style={markStyle(at)} />
            ))}
          </div>
        )}
      </div>
      {marks.length > 0 && (
        <div className="frame-slider__alarm-strip">
          {marks.map(({ alarm, at }) => (
            <button
              key={alarm.key}
              type="button"
              className="frame-slider__alarm-jump"
              style={markStyle(at)}
              title={alarm.label}
              aria-label={alarm.label}
              onClick={() => onChange(frameAt(timestamps, alarm.from))}
            />
          ))}
        </div>
      )}
      {count > 1 && (
        // The thumb's centre travels half a thumb (1 rem) inside the input.
        <div style={{ margin: '-4px 0.5rem 0' }}>
          <TimeAxis from={timestamps[0] * 1000} to={timestamps[count - 1] * 1000} position={position} />
        </div>
      )}
    </div>
  );
};

export default FrameSlider;
