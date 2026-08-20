import { useLayoutEffect, useRef, useState } from 'react';
import { formatDuration } from './alarmUtils';
import './AlarmTooltip.css';

type RainTooltipProps = {
  /** Rain window start/end in ms (from alarmRainSpan). */
  start: number;
  end: number;
  /** Precipitation in mm, if known. */
  amount?: number | null;
  /** Cursor position relative to the timeline body (px). */
  x: number;
  y: number;
  /** Size of the positioning container (the timeline body), for clamping. */
  containerWidth: number;
  containerHeight: number;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
};

const formatClock = (ms: number): string =>
  new Date(ms).toLocaleString(undefined, {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

/** Fixed gap between the cursor and the tooltip, in either direction. */
const CURSOR_GAP_PX = 50;
const EDGE_MARGIN_PX = 8;

const RainTooltip = ({
  start,
  end,
  amount,
  x,
  y,
  containerWidth,
  containerHeight,
  onMouseEnter,
  onMouseLeave,
}: RainTooltipProps) => {
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(
    null,
  );

  // Measure the rendered tooltip so its position can be computed exactly
  // (drawn above the cursor, flipped below when there is no room up top).
  useLayoutEffect(() => {
    const node = tooltipRef.current;
    if (!node) {
      return;
    }
    const measure = () => {
      const rect = node.getBoundingClientRect();
      setSize({ width: rect.width, height: rect.height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const width = size?.width ?? 200;
  const height = size?.height ?? 0;

  // Horizontally center the tooltip on the cursor, clamped to the container.
  const left = Math.min(
    Math.max(x, width / 2 + EDGE_MARGIN_PX),
    Math.max(
      containerWidth - width / 2 - EDGE_MARGIN_PX,
      width / 2 + EDGE_MARGIN_PX,
    ),
  );

  // Prefer drawing above the cursor; flip below when it would clip the top.
  let top = y - height - CURSOR_GAP_PX;
  if (top < EDGE_MARGIN_PX) {
    top = y + CURSOR_GAP_PX;
  }
  const maxTop = Math.max(
    EDGE_MARGIN_PX,
    containerHeight - height - EDGE_MARGIN_PX,
  );
  top = Math.min(Math.max(top, EDGE_MARGIN_PX), maxTop);

  return (
    <div
      ref={tooltipRef}
      className="alarm-tooltip"
      style={{ left, top, width: 200 }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="alarm-tooltip-head">
        <span
          className="alarm-tooltip-dot"
          style={{ background: '#0d6efd', borderColor: '#0d6efd' }}
        />
        <span className="alarm-tooltip-title">💧 Rain</span>
      </div>

      <div className="alarm-tooltip-body">
        <div className="alarm-tooltip-row">
          <span className="alarm-tooltip-key">Start</span>
          <span className="alarm-tooltip-value">{formatClock(start)}</span>
        </div>
        <div className="alarm-tooltip-row">
          <span className="alarm-tooltip-key">Duration</span>
          <span className="alarm-tooltip-value">
            {formatDuration((end - start) / 1000)}
          </span>
        </div>
        {amount != null && (
          <div className="alarm-tooltip-row">
            <span className="alarm-tooltip-key">Amount</span>
            <span className="alarm-tooltip-value">
              {Math.round(amount * 10) / 10} mm
            </span>
          </div>
        )}
      </div>
    </div>
  );
};

export default RainTooltip;
