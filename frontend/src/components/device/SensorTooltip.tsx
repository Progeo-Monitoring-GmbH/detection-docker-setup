import CursorTooltip, { TooltipRow } from '../ui/CursorTooltip';
import { alarmHeatColor } from '../../main/alarmUtils';
import { formatMeters } from './planMeters';

type SensorTooltipProps = {
  /** 1-based sensor position on the lageplan. */
  sensorPos: number;
  /** Optional name of the sensor (ProgeoMeasurePoint.name), shown in the title. */
  name?: string | null;
  /** Position in meters on the lageplan; null when it isn't calibrated. */
  meters: [number, number] | null;
  /** Current weight/value of the sensor (depends on the aggregation mode). */
  value: number;
  threshold?: number | null;
  /** Unit of the value (field heatmaps: "%", "°C"); none for heat. */
  unit?: string;
  /** Decimals of the value (default: up to 2). */
  decimals?: number;
  /** Colour of the title dot; default: the value's alarm heat colour. */
  dotColor?: string;
  /** Cursor position relative to the heatmap container (px). */
  cursorX: number;
  cursorY: number;
  containerWidth: number;
  containerHeight: number;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
};

const round2 = (value: number) => Math.round(value * 100) / 100;

const SensorTooltip = ({
  sensorPos,
  name,
  meters,
  value,
  threshold,
  unit,
  decimals,
  dotColor,
  ...rest
}: SensorTooltipProps) => (
  <CursorTooltip
    width={200}
    dotColor={dotColor ?? alarmHeatColor({ threshold, max_value: value, max_values: [] })}
    title={name ? `${name} (#${sensorPos})` : `Sensor #${sensorPos}`}
    {...rest}
  >
    <TooltipRow label="Value">
      {Number.isFinite(value)
        ? `${decimals != null ? value.toFixed(decimals) : round2(value)}${unit ? ` ${unit}` : ''}`
        : '-'}
    </TooltipRow>
    {meters && <TooltipRow label="Position">{formatMeters(meters)}</TooltipRow>}
    {threshold != null && <TooltipRow label="Threshold">{threshold}</TooltipRow>}
  </CursorTooltip>
);

export default SensorTooltip;
