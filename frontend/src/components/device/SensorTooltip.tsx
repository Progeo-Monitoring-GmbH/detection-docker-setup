import CursorTooltip, { TooltipRow } from '../ui/CursorTooltip';
import { alarmHeatColor } from '../../main/alarmUtils';

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

const round2 = (value: number) => Math.round(value * 100) / 100;

const SensorTooltip = ({ sensorPos, x, y, value, threshold, ...rest }: SensorTooltipProps) => (
  <CursorTooltip
    width={200}
    dotColor={alarmHeatColor({ threshold, max_value: value, max_values: [] })}
    title={`Sensor #${sensorPos}`}
    {...rest}
  >
    <TooltipRow label="Value">{Number.isFinite(value) ? round2(value) : '-'}</TooltipRow>
    <TooltipRow label="Position">
      ({round2(x)}, {round2(y)})
    </TooltipRow>
    {threshold != null && <TooltipRow label="Threshold">{threshold}</TooltipRow>}
  </CursorTooltip>
);

export default SensorTooltip;
