/**
 * The alignment panel under the plan canvas of ImageCanvasStage: auto
 * alignment and its result, the vertical flip, the point calibration (A)
 * and the sliders - moves and scales the measure points onto the plan.
 * Styles in ImageCanvasStage.css.
 */
import { Magic } from 'react-bootstrap-icons';
import { childTestId } from '../../testIds';
import type { AlignmentValues } from './imageCanvasGeometry';

/** Auto alignment (measure_points/auto_align): the request, the share of
 * sensor points it laid onto the plan's orange lines and the values before
 * - for Undo. */
export type AutoAlignState =
  | { busy: true }
  | { busy: false; score: number; matched: boolean; before: AlignmentValues }
  | { busy: false; error: string }
  | null;

type Slider = {
  id: string;
  label: string;
  value: number;
  display: string;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
};

type SliderSetters = {
  setOffsetX: (value: number) => void;
  setOffsetY: (value: number) => void;
  setScaleX: (value: number) => void;
  setScaleY: (value: number) => void;
};

const slidersOf = (alignment: AlignmentValues, set: SliderSetters): Slider[] => [
  {
    id: 'point-offset-x',
    label: 'Offset X',
    value: alignment.offsetX,
    display: String(alignment.offsetX),
    min: -250,
    max: 250,
    step: 1,
    onChange: set.setOffsetX,
  },
  {
    id: 'point-offset-y',
    label: 'Offset Y',
    value: alignment.offsetY,
    display: String(alignment.offsetY),
    min: -250,
    max: 250,
    step: 1,
    onChange: set.setOffsetY,
  },
  // Four decimals - "Align" computes them that precisely.
  {
    id: 'point-scale-x',
    label: 'Scale X',
    value: alignment.scaleX,
    display: alignment.scaleX.toFixed(4),
    min: 0.1,
    max: 5,
    step: 0.0001,
    onChange: set.setScaleX,
  },
  {
    id: 'point-scale-y',
    label: 'Scale Y',
    value: alignment.scaleY,
    display: alignment.scaleY.toFixed(4),
    min: 0.1,
    max: 5,
    step: 0.0001,
    onChange: set.setScaleY,
  },
];

const autoAlignTone = (state: Exclude<AutoAlignState, null | { busy: true }>) => {
  if ('error' in state) {
    return 'image-canvas-action--error';
  }
  return state.matched ? 'image-canvas-action--align' : 'image-canvas-action--warning';
};

/** What the auto alignment did - Undo restores the alignment before. */
const AutoAlignResult = ({
  state,
  onUndo,
  onClose,
  testId,
}: {
  state: Exclude<AutoAlignState, null | { busy: true }>;
  onUndo: (before: AlignmentValues) => void;
  onClose: () => void;
  testId: string;
}) => (
  <div
    className={`image-canvas-action d-flex flex-wrap align-items-center gap-2 ${autoAlignTone(state)}`}
    data-testid={childTestId(testId, 'auto-align-result')}
  >
    <div className="image-canvas-action-text">
      {'error' in state ? (
        state.error
      ) : (
        <>
          <div className="image-canvas-action-title">
            {state.matched ? 'Aligned to the orange lines' : 'Only a rough match'}
          </div>
          {Math.round(state.score * 100)}% of the sensor points lie on the orange lines of the plan
          {state.matched
            ? ' - stored. Check it, fine-tune with the sliders or hold A.'
            : ' - check the result, or undo and align by hand (hold A).'}
        </>
      )}
    </div>
    {'before' in state && (
      <button
        type="button"
        className="image-canvas-pill btn btn-sm btn-outline-secondary"
        onClick={() => onUndo(state.before)}
        data-testid={childTestId(testId, 'auto-align-undo')}
      >
        Undo
      </button>
    )}
    <button
      type="button"
      className="image-canvas-pill btn btn-sm btn-outline-secondary"
      onClick={onClose}
      data-testid={childTestId(testId, 'auto-align-close')}
    >
      OK
    </button>
  </div>
);

const AlignmentSliders = ({ sliders, testId }: { sliders: Slider[]; testId: string }) => (
  <div className="image-canvas-sliders">
    {sliders.map((slider) => (
      <div key={slider.id}>
        <label htmlFor={slider.id} className="image-canvas-muted d-flex justify-content-between mb-0">
          <span>{slider.label}</span>
          <span
            className="image-canvas-slider-value font-monospace"
            data-testid={childTestId(testId, 'slider-value')}
            data-test-key={slider.id}
          >
            {slider.display}
          </span>
        </label>
        <input
          id={slider.id}
          className="form-range"
          type="range"
          // A computed value outside the usual range widens it.
          min={Math.min(slider.min, slider.value)}
          max={Math.max(slider.max, slider.value)}
          step={slider.step}
          value={slider.value}
          onChange={(event) => slider.onChange(Number(event.target.value))}
          data-testid={childTestId(testId, 'slider')}
          data-test-key={slider.id}
        />
      </div>
    ))}
  </div>
);

const AutoAlignButton = ({
  busy,
  aligning,
  onClick,
  testId,
}: {
  busy: boolean;
  aligning: boolean;
  onClick: () => void;
  testId: string;
}) => (
  <button
    type="button"
    className="image-canvas-pill image-canvas-auto btn btn-sm"
    onClick={onClick}
    disabled={busy || aligning}
    title="Lay the measure points onto the orange lines of the plan"
    data-testid={childTestId(testId, 'auto-align')}
  >
    {busy ? <span className="spinner-border spinner-border-sm me-1" aria-hidden /> : <Magic className="me-1" aria-hidden />}
    Auto-align
  </button>
);

/** The point calibration (A) going on: its pins and how well they fit. */
const AligningNotice = ({
  pins,
  lineMode,
  hint,
  testId,
}: {
  pins: number;
  lineMode: boolean;
  hint: string;
  testId: string;
}) => (
  <div
    className="image-canvas-action image-canvas-action--align d-flex flex-wrap align-items-center gap-2"
    data-testid={childTestId(testId, 'aligning')}
  >
    <div className="image-canvas-action-text">
      <div className="image-canvas-action-title">
        {pins} {lineMode ? 'dm sensor(s)' : 'sensor(s)'} pinned
      </div>
      <div>{hint}</div>
    </div>
  </div>
);

const AlignKeyHint = ({ lineMode, testId }: { lineMode: boolean; testId: string }) => (
  <div className="image-canvas-hint d-flex align-items-center gap-2" data-testid={childTestId(testId, 'align-hint')}>
    <kbd className="canvas-key-badge">A</kbd>
    <span>
      Hold <strong>A</strong> and drag a {lineMode ? 'dm line' : 'sensor'} onto its right place on
      the plan - two far apart (e.g. opposite corners) set the alignment, more refine it.
    </span>
  </div>
);

/** How to calibrate with A - or, going on, its pins and how well they fit. */
const PointCalibrationState = ({
  canAlign,
  aligning,
  pins,
  lineMode,
  hint,
  testId,
}: {
  canAlign: boolean;
  aligning: boolean;
  pins: number;
  lineMode: boolean;
  hint: string;
  testId: string;
}) => {
  if (aligning) {
    return <AligningNotice pins={pins} lineMode={lineMode} hint={hint} testId={testId} />;
  }
  return canAlign ? <AlignKeyHint lineMode={lineMode} testId={testId} /> : null;
};

export const AlignmentPanel = ({
  alignment,
  setters,
  onToggleFlip,
  canAutoAlign,
  autoAlign,
  onAutoAlign,
  onUndoAutoAlign,
  onCloseAutoAlign,
  canAlign,
  aligning,
  pins,
  alignHintText,
  lineMode,
  testId,
}: {
  alignment: AlignmentValues;
  setters: SliderSetters;
  onToggleFlip: () => void;
  canAutoAlign: boolean;
  autoAlign: AutoAlignState;
  onAutoAlign: () => void;
  onUndoAutoAlign: (before: AlignmentValues) => void;
  onCloseAutoAlign: () => void;
  canAlign: boolean;
  aligning: boolean;
  pins: number;
  alignHintText: string;
  lineMode: boolean;
  testId: string;
}) => (
  <div className="image-canvas-sub-panel" data-testid={childTestId(testId, 'alignment')}>
    <div className="d-flex align-items-center gap-2 flex-wrap">
      <div>
        <div className="image-canvas-sub-title">Alignment</div>
        <div className="image-canvas-muted">
          Moves and scales the measure points onto the plan - stored
          automatically.
        </div>
      </div>
      <div className="ms-auto d-flex gap-2">
        {canAutoAlign && (
          <AutoAlignButton busy={autoAlign?.busy === true} aligning={aligning} onClick={onAutoAlign} testId={testId} />
        )}
        <button
          type="button"
          className={`image-canvas-pill btn btn-sm ${alignment.flipY ? 'btn-secondary' : 'btn-outline-secondary'}`}
          aria-pressed={alignment.flipY}
          onClick={onToggleFlip}
          data-testid={childTestId(testId, 'flip-vertical')}
        >
          Vertical flip
        </button>
      </div>
    </div>

    {autoAlign && !autoAlign.busy && (
      <AutoAlignResult state={autoAlign} onUndo={onUndoAutoAlign} onClose={onCloseAutoAlign} testId={testId} />
    )}

    <PointCalibrationState
      canAlign={canAlign}
      aligning={aligning}
      pins={pins}
      lineMode={lineMode}
      hint={alignHintText}
      testId={testId}
    />

    <AlignmentSliders sliders={slidersOf(alignment, setters)} testId={testId} />
  </div>
);
