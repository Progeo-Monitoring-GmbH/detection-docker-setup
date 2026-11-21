/**
 * What floats on the plan canvas of ImageCanvasStage (besides the zoom
 * controls): the rotate buttons, the badge of the mode in use and a
 * sensor's tooltip. Styles in ImageCanvasStage.css.
 */
import { ArrowClockwise, ArrowCounterclockwise } from 'react-bootstrap-icons';
import { childTestId } from '../../testIds';
import { clamp, type MarkerItem } from './imageCanvasGeometry';
import { tooltipRows, type Badge } from './imageCanvasModes';

/** Turns the image by 90 degrees - the measure points turn with it. */
export const RotateButtons = ({
  shown,
  disabled,
  onRotate,
  testId,
}: {
  shown: boolean;
  disabled: boolean;
  onRotate: (clockwise: boolean) => void;
  testId: string;
}) =>
  shown ? (
    <div className="image-canvas-rotate d-flex gap-1">
      {([false, true] as const).map((clockwise) => (
        <button
          key={String(clockwise)}
          type="button"
          className="image-canvas-rotate-button btn btn-sm btn-light d-inline-flex align-items-center justify-content-center"
          title={clockwise ? 'Rotate 90° clockwise' : 'Rotate 90° counterclockwise'}
          aria-label={clockwise ? 'Rotate the plan 90° clockwise' : 'Rotate the plan 90° counterclockwise'}
          disabled={disabled}
          onClick={() => onRotate(clockwise)}
          data-testid={childTestId(testId, 'rotate')}
          data-test-key={clockwise ? 'clockwise' : 'counterclockwise'}
        >
          {clockwise ? <ArrowClockwise size={15} /> : <ArrowCounterclockwise size={15} />}
        </button>
      ))}
    </div>
  ) : null;

/** What a held key / the edit mode does - its colour inline. */
export const CanvasBadge = ({ badge, testId }: { badge: Badge | null; testId: string }) =>
  badge ? (
    <div
      aria-live="polite"
      className="image-canvas-badge"
      data-testid={childTestId(testId, 'badge')}
      style={{ background: badge.color }}
    >
      {badge.text}
    </div>
  ) : null;

/** The tooltip of the measure point / dm line under the mouse (CSS pixels
 * over the canvas) - above the cursor near the canvas' bottom. */
export const CanvasTooltip = ({
  hover,
  item,
  info,
  cssWidth,
  cssHeight,
  testId,
}: {
  hover: { x: number; y: number } | null;
  item: MarkerItem | null;
  info: Parameters<typeof tooltipRows>[1];
  cssWidth: number;
  cssHeight: number;
  testId: string;
}) => {
  if (!hover || !item) {
    return null;
  }
  const below = hover.y < cssHeight - 140;
  return (
    <div
      role="tooltip"
      data-testid={childTestId(testId, 'tooltip')}
      className={below ? 'image-canvas-tooltip' : 'image-canvas-tooltip image-canvas-tooltip--above'}
      style={{
        left: clamp(hover.x + 14, 4, Math.max(4, cssWidth - 244)),
        top: below ? hover.y + 16 : hover.y - 16,
      }}
    >
      <div className="image-canvas-tooltip-title d-flex align-items-center gap-2">
        <span className="image-canvas-tooltip-dot" style={{ background: item.color }} />
        {info.lineMode ? `dm ${item.label}` : `Sensor ${item.label}`}
      </div>
      {tooltipRows(item, info).map(([label, value]) => (
        <div key={label} className="d-flex gap-2">
          <span className="image-canvas-tooltip-label">{label}</span>
          <span className="ms-auto text-end">{value}</span>
        </div>
      ))}
    </div>
  );
};
