import { Button } from 'react-bootstrap';
import { ArrowRightCircle } from 'react-bootstrap-icons';
import { useNavigate } from 'react-router';
import {
  alarmHeatColor,
  alarmPeakValue,
  alarmSensors,
  formatDuration,
  isAlarmActive,
  parseTimestamp,
  type TimelineAlarm,
} from './alarmUtils';
import CursorTooltip, { formatClock, TooltipRow } from '../components/ui/CursorTooltip';

type AlarmTooltipProps = {
  alarm: TimelineAlarm;
  /** Alarm window start in ms (from alarmStartTime). */
  start: number;
  /** Alarm window end in ms (normalized_at, or `now` while still active). */
  end: number;
  /** Current wall-clock time in ms - shown for still-active alarms. */
  now: number;
  /** Cursor position relative to the timeline body (px). */
  x: number;
  y: number;
  /** Size of the positioning container (the timeline body), for clamping. */
  containerWidth: number;
  containerHeight: number;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
};

const AlarmTooltip = ({
  alarm,
  start,
  end,
  now,
  x,
  y,
  containerWidth,
  containerHeight,
  onMouseEnter,
  onMouseLeave,
}: AlarmTooltipProps) => {
  const navigate = useNavigate();
  const active = isAlarmActive(alarm);
  const peak = alarmPeakValue(alarm);
  const sensors = alarmSensors(alarm);
  const locationId = alarm.location?.id ?? alarm.location?.project_id ?? null;
  const evaluatedAt = parseTimestamp(alarm.evaluated_at);

  const openDetails = () => {
    if (locationId != null) {
      navigate(`/location/${locationId}/alarms`);
    }
  };

  return (
    <CursorTooltip
      cursorX={x}
      cursorY={y}
      containerWidth={containerWidth}
      containerHeight={containerHeight}
      fallbackWidth={260}
      dotColor={alarmHeatColor(alarm)}
      dotBorderColor={active ? '#dc3545' : '#198754'}
      title={`Alarm #${alarm.id}`}
      headExtra={
        <span className={['badge', active ? 'text-bg-danger' : 'text-bg-success'].join(' ')}>
          {active ? 'Still active' : 'Normalized'}
        </span>
      }
      footer={
        locationId != null && (
          <div className="alarm-tooltip-actions">
            <Button size="sm" variant="primary" onClick={openDetails} className="w-100">
              <ArrowRightCircle className="me-1" />
              Open alarm details
            </Button>
          </div>
        )
      }
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {alarm.location?.name && <TooltipRow label="Location">{alarm.location.name}</TooltipRow>}
      {(alarm.device?.mac || alarm.device?.raw_hash) && (
        <TooltipRow label="Device">{alarm.device?.mac || alarm.device?.raw_hash}</TooltipRow>
      )}
      {sensors.length > 0 && (
        <TooltipRow label="Sensors">
          {sensors
            .map(
              (pair) =>
                `#${pair.sensor_id ?? '-'}${pair.max_value != null ? ` (${pair.max_value})` : ''}`,
            )
            .join(', ')}
        </TooltipRow>
      )}
      {peak != null && <TooltipRow label="Max value">{peak}</TooltipRow>}
      <TooltipRow label="Triggered">{formatClock(start)}</TooltipRow>
      <TooltipRow label={active ? 'Running for' : 'Active for'}>
        {formatDuration((end - start) / 1000)}
      </TooltipRow>
      {active ? (
        <TooltipRow label="Last activity">{formatDuration((now - start) / 1000)} ago</TooltipRow>
      ) : (
        <TooltipRow label="Normalized">{formatClock(end)}</TooltipRow>
      )}
      {alarm.status === 1 && (
        <TooltipRow label="Acknowledged">
          {alarm.evaluated_by?.username || 'unknown'}
          {evaluatedAt != null ? ` · ${formatClock(evaluatedAt)}` : ''}
        </TooltipRow>
      )}
    </CursorTooltip>
  );
};

export default AlarmTooltip;
