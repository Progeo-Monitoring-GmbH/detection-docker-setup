import CursorTooltip, { TooltipRow } from '../ui/CursorTooltip';
import { alarmHeatColor } from '../../main/alarmUtils';
import { formatMeters } from './planMeters';

type SensorTooltipProps = {
  /** 1-based sensor position on the lageplan. */
  sensorPos: number;
  /** Position in meters on the lageplan; null when it isn't calibrated. */
  meters: [number, number] | null;
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

const SensorTooltip = ({ sensorPos, meters, value, threshold, ...rest }: SensorTooltipProps) => (
  <CursorTooltip
    width={200}
    dotColor={alarmHeatColor({ threshold, max_value: value, max_values: [] })}
    title={`Sensor #${sensorPos}`}
    {...rest}
  >
    <TooltipRow label="Value">{Number.isFinite(value) ? round2(value) : '-'}</TooltipRow>
    {meters && <TooltipRow label="Position">{formatMeters(meters)}</TooltipRow>}
    {threshold != null && <TooltipRow label="Threshold">{threshold}</TooltipRow>}
  </CursorTooltip>
);

export default SensorTooltip;
