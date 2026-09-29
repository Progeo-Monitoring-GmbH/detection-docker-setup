import { useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import '../../main/AlarmTooltip.css';

/** Fixed gap between the cursor and the tooltip, in either direction. */
const CURSOR_GAP_PX = 50;
const EDGE_MARGIN_PX = 8;

type CursorTooltipProps = {
  /** Cursor position relative to the positioning container (px). */
  cursorX: number;
  cursorY: number;
  /** Size of the positioning container, for clamping. */
  containerWidth: number;
  containerHeight: number;
  /** Fixed tooltip width; otherwise the CSS width is used. */
  width?: number;
  /** Width assumed for positioning before the first measurement. */
  fallbackWidth?: number;
  dotColor: string;
  dotBorderColor?: string;
  title: ReactNode;
  /** Extra header content next to the title (e.g. a status badge). */
  headExtra?: ReactNode;
  /** Content below the rows (e.g. action buttons). */
  footer?: ReactNode;
  children: ReactNode;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
};

export const formatClock = (ms: number): string =>
  new Date(ms).toLocaleString(undefined, {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

/** One "key: value" line of a CursorTooltip. */
export const TooltipRow = ({ label, children }: { label: ReactNode; children: ReactNode }) => (
  <div className="alarm-tooltip-row">
    <span className="alarm-tooltip-key">{label}</span>
    <span className="alarm-tooltip-value">{children}</span>
  </div>
);

/**
 * Shared shell of the timeline/heatmap hover tooltips: measures itself,
 * centers horizontally on the cursor (clamped to the container) and is drawn
 * above the cursor, flipping below when there is no room up top.
 */
const CursorTooltip = ({
  cursorX,
  cursorY,
  containerWidth,
  containerHeight,
  width: fixedWidth,
  fallbackWidth = 200,
  dotColor,
  dotBorderColor,
  title,
  headExtra,
  footer,
  children,
  onMouseEnter,
  onMouseLeave,
}: CursorTooltipProps) => {
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);

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

  const width = size?.width ?? fixedWidth ?? fallbackWidth;
  const height = size?.height ?? 0;

  const left = Math.min(
    Math.max(cursorX, width / 2 + EDGE_MARGIN_PX),
    Math.max(containerWidth - width / 2 - EDGE_MARGIN_PX, width / 2 + EDGE_MARGIN_PX),
  );

  let top = cursorY - height - CURSOR_GAP_PX;
  if (top < EDGE_MARGIN_PX) {
    top = cursorY + CURSOR_GAP_PX;
  }
  const maxTop = Math.max(EDGE_MARGIN_PX, containerHeight - height - EDGE_MARGIN_PX);
  top = Math.min(Math.max(top, EDGE_MARGIN_PX), maxTop);

  return (
    <div
      ref={tooltipRef}
      className="alarm-tooltip"
      style={{ left, top, ...(fixedWidth != null ? { width: fixedWidth } : {}) }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="alarm-tooltip-head">
        <span
          className="alarm-tooltip-dot"
          style={{ background: dotColor, borderColor: dotBorderColor ?? dotColor }}
        />
        <span className="alarm-tooltip-title">{title}</span>
        {headExtra}
      </div>
      <div className="alarm-tooltip-body">{children}</div>
      {footer}
    </div>
  );
};

export default CursorTooltip;
