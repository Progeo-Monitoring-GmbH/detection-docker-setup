import { useLayoutEffect, useRef, useState } from 'react';
import { alarmHeatColor } from '../../main/alarmUtils';
import '../../main/AlarmTooltip.css';

type SensorTooltipProps = {
  /** 1-based sensor position on the lageplan. */
  sensorPos: number;
  /** Normalized (nx, ny) coordinates, as displayed on the plot. */
  x: number;
  y: number;
  /** Current weight/value of the sensor (depends on the aggregation mode). */
  value: number;
  threshold?: number | null;
  /** Cursor position relative to the heatmap container (px). */
  cursorX: number;
  cursorY: number;
  containerWidth: number;
  containerHeight: number;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
};

/** Fixed gap between the cursor and the tooltip, in either direction. */
const CURSOR_GAP_PX = 50;
const EDGE_MARGIN_PX = 8;

const SensorTooltip = ({
  sensorPos,
  x,
  y,
  value,
  threshold,
  cursorX,
  cursorY,
  containerWidth,
  containerHeight,
  onMouseEnter,
  onMouseLeave,
}: SensorTooltipProps) => {
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
    Math.max(cursorX, width / 2 + EDGE_MARGIN_PX),
    Math.max(
      containerWidth - width / 2 - EDGE_MARGIN_PX,
      width / 2 + EDGE_MARGIN_PX,
    ),
  );

  // Prefer drawing above the cursor; flip below when it would clip the top.
  let top = cursorY - height - CURSOR_GAP_PX;
  if (top < EDGE_MARGIN_PX) {
    top = cursorY + CURSOR_GAP_PX;
  }
  const maxTop = Math.max(
    EDGE_MARGIN_PX,
    containerHeight - height - EDGE_MARGIN_PX,
  );
  top = Math.min(Math.max(top, EDGE_MARGIN_PX), maxTop);

  const heatColor = alarmHeatColor({
    threshold,
    max_value: value,
    max_values: [],
  });

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
          style={{ background: heatColor, borderColor: heatColor }}
        />
        <span className="alarm-tooltip-title">Sensor #{sensorPos}</span>
      </div>

      <div className="alarm-tooltip-body">
        <div className="alarm-tooltip-row">
          <span className="alarm-tooltip-key">Value</span>
          <span className="alarm-tooltip-value">
            {Number.isFinite(value) ? Math.round(value * 100) / 100 : '-'}
          </span>
        </div>
        <div className="alarm-tooltip-row">
          <span className="alarm-tooltip-key">Position</span>
          <span className="alarm-tooltip-value">
            ({Math.round(x * 100) / 100}, {Math.round(y * 100) / 100})
          </span>
        </div>
        {threshold != null && (
          <div className="alarm-tooltip-row">
            <span className="alarm-tooltip-key">Threshold</span>
            <span className="alarm-tooltip-value">{threshold}</span>
          </div>
        )}
      </div>
    </div>
  );
};

export default SensorTooltip;
