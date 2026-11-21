/**
 * Small blocks under the plan canvas of ImageCanvasStage: the footer (zoom,
 * colour scale), the missing-bands warning and the panels of a running
 * group alignment / of cut points. Styles in ImageCanvasStage.css.
 */
import { childTestId } from '../../testIds';
import { RAINBOW_GRADIENT, type MarkerItem } from './imageCanvasGeometry';
import { groupHint, pointNounOf } from './imageCanvasModes';

/** The zoom and the sensors' colour scale, first to last. */
export const CanvasFooter = ({
  zoom,
  items,
  lineMode,
  lineCount,
  placing,
  testId,
}: {
  zoom: number;
  items: MarkerItem[];
  lineMode: boolean;
  lineCount: number;
  placing: boolean;
  testId: string;
}) => (
  <div
    className="image-canvas-muted image-canvas-footer d-flex justify-content-between align-items-center gap-2 flex-wrap"
    data-testid={childTestId(testId, 'footer')}
  >
    <span data-testid={childTestId(testId, 'zoom-level')}>Zoom {zoom.toFixed(2)}×</span>
    {!placing && items.length > 1 && (
      <span className="d-flex align-items-center gap-2">
        <span>{lineMode ? `dm ${items[0].label}` : items[0].label}</span>
        <span aria-hidden="true" className="image-canvas-rainbow" style={{ background: RAINBOW_GRADIENT }} />
        <span>{items[items.length - 1].label}</span>
        {lineMode && (
          <span>
            · {lineCount} line(s)
            {items.length > lineCount ? ` · ${items.length - lineCount} without band` : ''}
          </span>
        )}
      </span>
    )}
  </div>
);

/** The title and file name over the canvas. */
export const StageHeader = ({ title, fileName, testId }: { title: string; fileName?: string; testId: string }) => (
  <div className="d-flex justify-content-between align-items-baseline gap-2 flex-wrap">
    <span className="image-canvas-title" data-testid={childTestId(testId, 'title')}>{title}</span>
    {fileName && (
      <span className="image-canvas-muted" data-testid={childTestId(testId, 'file-name')}>{fileName}</span>
    )}
  </div>
);

/** A smartex dm project whose measure points have no band ends (not while placing sensors by hand). */
export const NoLinesWarning = ({
  placing,
  lineSensors,
  itemCount,
  lineCount,
  testId,
}: {
  placing: boolean;
  lineSensors: boolean;
  itemCount: number;
  lineCount: number;
  testId: string;
}) =>
  !placing && lineSensors && itemCount > 0 && lineCount === 0 ? (
    <div className="image-canvas-action image-canvas-action--warning" data-testid={childTestId(testId, 'no-lines-warning')}>
      This is a smartex dm project, but these measure points have no band
      ends - import the DWG/DXF again in step 3 to get the sensor lines.
    </div>
  ) : null;

/** A group alignment (L) going on: its points and pins. */
export const GroupPanel = ({
  group,
  problem,
  lineMode,
  testId,
}: {
  group: { size: number; pins: number } | null;
  problem: string | null;
  lineMode: boolean;
  testId: string;
}) =>
  group ? (
    <div
      className="image-canvas-action image-canvas-action--group d-flex flex-wrap align-items-center gap-2"
      data-testid={childTestId(testId, 'group')}
    >
      <div className="image-canvas-action-text">
        <div className="image-canvas-action-title">
          Aligning {group.size} {pointNounOf(lineMode)}(s) by themselves · {group.pins} pinned
        </div>
        <div>{groupHint(group.pins, problem, lineMode)}</div>
      </div>
    </div>
  ) : null;

/** Measure points cut out (O), until inserted (I + click) or put back. */
export const CutPanel = ({
  count,
  canInsert,
  lineMode,
  busy,
  onDiscard,
  testId,
}: {
  count: number;
  canInsert: boolean;
  lineMode: boolean;
  busy: boolean;
  onDiscard?: () => void;
  testId: string;
}) =>
  count > 0 ? (
    <div
      className="image-canvas-action image-canvas-action--cut d-flex flex-wrap align-items-center gap-2"
      data-testid={childTestId(testId, 'cut')}
    >
      <div className="image-canvas-action-text">
        <div className="image-canvas-action-title">
          {count} {pointNounOf(lineMode)}(s) cut out
        </div>
        <div>
          {canInsert ? (
            <>
              Hold <kbd className="canvas-key-badge">I</kbd> and click where they go - on this plan or another one. Until
              then they stay where they were.
            </>
          ) : (
            'Open the plan they go onto to insert them. Until then they stay where they were.'
          )}
        </div>
      </div>
      {onDiscard && (
        <button
          type="button"
          className="image-canvas-pill btn btn-sm btn-outline-secondary"
          disabled={busy}
          onClick={onDiscard}
          data-testid={childTestId(testId, 'cut-discard')}
        >
          Put back
        </button>
      )}
    </div>
  ) : null;

/** An error under the canvas (an edit, loading the image). */
export const CanvasError = ({ message, alert, testId }: { message: string; alert?: boolean; testId?: string }) =>
  message ? (
    <div role={alert ? 'alert' : undefined} className="image-canvas-action image-canvas-action--error" data-testid={testId}>
      {message}
    </div>
  ) : null;
