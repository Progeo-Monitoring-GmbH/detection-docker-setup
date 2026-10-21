import { useEffect, useRef, useState } from 'react';
import { Spinner } from 'react-bootstrap';
import { useTranslation } from 'react-i18next';
import {
  frameCount,
  HEATMAP_MAX_FRAMES,
  HEATMAP_STEPS,
  type HeatmapWindow,
  WINDOW_GRID_MS,
} from './heatmapSteps';
import './HeatmapRangeControls.css';

type HeatmapRangeControlsProps = {
  /** Oldest / newest selectable moment (ms) - the location's measurements. */
  min: number;
  max: number;
  value: HeatmapWindow;
  /** Called once the user is done (not on every slider movement). */
  onChange: (value: HeatmapWindow) => void;
  loading?: boolean;
};

/** Pause after the last slider movement before the window is loaded. */
const COMMIT_DELAY_MS = 400;

const formatMoment = (ms: number) =>
  new Date(ms).toLocaleString(undefined, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

/**
 * Time window and step of the heatmap: a slider with two handles over the
 * location's measurements, and the step width. Each frame then holds every
 * sensor's highest value within one step. Steps that would give more than
 * HEATMAP_MAX_FRAMES frames for the window are disabled.
 */
const HeatmapRangeControls = ({ min, max, value, onChange, loading = false }: HeatmapRangeControlsProps) => {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(value);
  const commitTimer = useRef<number | null>(null);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  useEffect(() => () => {
    if (commitTimer.current != null) {
      window.clearTimeout(commitTimer.current);
    }
  }, []);

  const span = Math.max(max - min, WINDOW_GRID_MS);
  const positions = Math.max(1, Math.round(span / WINDOW_GRID_MS));
  const toPosition = (ms: number) => Math.round((Math.min(Math.max(ms, min), max) - min) / WINDOW_GRID_MS);
  const toMs = (position: number) => Math.min(min + position * WINDOW_GRID_MS, max);

  const commitLater = (next: HeatmapWindow) => {
    setDraft(next);
    if (commitTimer.current != null) {
      window.clearTimeout(commitTimer.current);
    }
    commitTimer.current = window.setTimeout(() => {
      commitTimer.current = null;
      onChange(next);
    }, COMMIT_DELAY_MS);
  };

  // A window must hold at least one step and fit the frame limit.
  const fit = (next: HeatmapWindow, moved: 'from' | 'to'): HeatmapWindow => {
    const stepMs = next.step * 1000;
    let { from, to } = next;
    if (to - from < stepMs) {
      if (moved === 'from') {
        from = Math.max(min, to - stepMs);
      } else {
        to = Math.min(max, from + stepMs);
      }
    }
    if (frameCount(from, to, next.step) > HEATMAP_MAX_FRAMES) {
      if (moved === 'from') {
        from = to - HEATMAP_MAX_FRAMES * stepMs;
      } else {
        to = from + HEATMAP_MAX_FRAMES * stepMs;
      }
    }
    return { ...next, from, to };
  };

  const fromPosition = toPosition(draft.from);
  const toPosition_ = toPosition(draft.to);
  const frames = frameCount(draft.from, draft.to, draft.step);

  return (
    <div className="d-flex flex-column gap-1 px-2 pt-2" style={{ fontSize: 12.5 }}>
      <div className="d-flex flex-wrap align-items-center gap-2">
        <span className="text-muted">{t('heatmap_window_label')}</span>
        <strong style={{ color: 'var(--progeo-blue)' }}>
          {formatMoment(draft.from)} – {formatMoment(draft.to)}
        </strong>
        <span className="text-muted">
          · {t('heatmap_frames', { count: frames })} · {t('heatmap_step_hint')}
        </span>
        {loading && <Spinner size="sm" animation="border" className="ms-1" />}
      </div>

      <div className="heatmap-dual-range">
        <div className="heatmap-dual-range__track" />
        <div
          className="heatmap-dual-range__selection"
          style={{
            left: `${(fromPosition / positions) * 100}%`,
            right: `${100 - (toPosition_ / positions) * 100}%`,
          }}
        />
        <input
          type="range"
          min={0}
          max={positions}
          step={1}
          value={fromPosition}
          aria-label={`${t('heatmap_window_label')} – ${t('heatmap_window_from')}`}
          onChange={(event) =>
            commitLater(fit({ ...draft, from: Math.min(toMs(Number(event.target.value)), draft.to) }, 'from'))
          }
        />
        <input
          type="range"
          min={0}
          max={positions}
          step={1}
          value={toPosition_}
          aria-label={`${t('heatmap_window_label')} – ${t('heatmap_window_to')}`}
          onChange={(event) =>
            commitLater(fit({ ...draft, to: Math.max(toMs(Number(event.target.value)), draft.from) }, 'to'))
          }
        />
      </div>

      <div className="d-flex flex-wrap align-items-center gap-1">
        <span className="text-muted me-1">{t('heatmap_step_label')}</span>
        {HEATMAP_STEPS.map((step) => {
          const count = frameCount(draft.from, draft.to, step.seconds);
          const tooMany = count > HEATMAP_MAX_FRAMES;
          const active = step.seconds === draft.step;
          return (
            <button
              key={step.key}
              type="button"
              disabled={tooMany}
              title={tooMany ? t('heatmap_too_many_frames') : t('heatmap_frames', { count })}
              onClick={() => {
                if (commitTimer.current != null) {
                  window.clearTimeout(commitTimer.current); // the step click commits the moved window too
                  commitTimer.current = null;
                }
                const next = { ...draft, step: step.seconds };
                setDraft(next);
                onChange(next);
              }}
              style={{
                height: 26,
                padding: '0 9px',
                border: 'none',
                borderRadius: 'var(--progeo-radius-pill)',
                fontFamily: 'inherit',
                fontSize: 12,
                fontWeight: active ? 600 : 500,
                cursor: tooMany ? 'not-allowed' : 'pointer',
                opacity: tooMany ? 0.4 : 1,
                background: active ? 'var(--progeo-blue)' : 'var(--progeo-track-soft)',
                color: active ? '#fff' : 'var(--progeo-blue)',
              }}
            >
              {t(`heatmap_step_${step.key}`)}
            </button>
          );
        })}
      </div>
    </div>
  );
};

export default HeatmapRangeControls;
