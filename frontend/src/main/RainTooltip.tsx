import CursorTooltip, { formatClock, TooltipRow } from '../components/ui/CursorTooltip';
import { formatDuration } from './alarmUtils';

type RainTooltipProps = {
  /** Rain window start/end in ms (one span from alarmRainSpans). */
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

const RainTooltip = ({ start, end, amount, x, y, ...rest }: RainTooltipProps) => (
  <CursorTooltip cursorX={x} cursorY={y} width={200} dotColor="#0d6efd" title="💧 Rain" {...rest}>
    <TooltipRow label="Start">{formatClock(start)}</TooltipRow>
    <TooltipRow label="Duration">{formatDuration((end - start) / 1000)}</TooltipRow>
    {amount != null && <TooltipRow label="Amount">{Math.round(amount * 10) / 10} mm</TooltipRow>}
  </CursorTooltip>
);

export default RainTooltip;
