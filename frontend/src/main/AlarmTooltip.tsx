import { Button } from 'react-bootstrap';
import { ArrowRightCircle } from 'react-bootstrap-icons';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  alarmHeatColor,
  alarmPeakValue,
  alarmSensors,
  formatDuration,
  isAlarmActive,
  parseTimestamp,
  type TimelineAlarm,
} from './alarmUtils';
import type { ReactNode } from 'react';
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

/** A row only shown with a value. */
const OptionalRow = ({ label, children }: { label: string; children: ReactNode }) =>
  children == null || children === '' ? null : <TooltipRow label={label}>{children}</TooltipRow>;

/** "#3 (412), #5" - the sensors over threshold with their highest value. */
const sensorsText = (sensors: ReturnType<typeof alarmSensors>) =>
  sensors.length > 0
    ? sensors
        .map((pair) => `#${pair.sensor_id ?? '-'}${pair.max_value != null ? ` (${pair.max_value})` : ''}`)
        .join(', ')
    : null;

/** Who acknowledged the alarm, and when; null while it isn't. */
const acknowledgedText = (alarm: TimelineAlarm, t: TFunction) => {
  if (alarm.status !== 1) {
    return null;
  }
  const at = parseTimestamp(alarm.evaluated_at);
  return `${alarm.evaluated_by?.username || t('alarm_unknown_user')}${at != null ? ` · ${formatClock(at)}` : ''}`;
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
  const { t } = useTranslation();
  const active = isAlarmActive(alarm);
  const locationId = alarm.location?.id ?? alarm.location?.project_id ?? null;

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
      title={t('alarm_tooltip_title', { id: alarm.id })}
      headExtra={
        <span
          className={['badge', active ? 'text-bg-danger' : 'text-bg-success'].join(' ')}
          data-testid="alarm-tooltip-state"
        >
          {active ? t('alarm_tooltip_still_active') : t('alarm_tooltip_normalized')}
        </span>
      }
      footer={
        locationId != null && (
          <div className="alarm-tooltip-actions">
            <Button
              size="sm"
              variant="primary"
              onClick={openDetails}
              className="w-100"
              data-testid="alarm-tooltip-open-details"
            >
              <ArrowRightCircle className="me-1" />
              {t('alarm_tooltip_open_details')}
            </Button>
          </div>
        )
      }
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <OptionalRow label={t('alarm_detail_location')}>{alarm.location?.name}</OptionalRow>
      <OptionalRow label={t('alarm_field_device')}>{alarm.device?.display_name || alarm.device?.raw_hash}</OptionalRow>
      <OptionalRow label={t('alarm_field_sensors')}>{sensorsText(alarmSensors(alarm))}</OptionalRow>
      <OptionalRow label={t('alarm_field_max_value')}>{alarmPeakValue(alarm)}</OptionalRow>
      <TooltipRow label={t('alarm_field_triggered')}>{formatClock(start)}</TooltipRow>
      <TooltipRow label={active ? t('alarm_tooltip_running_for') : t('alarm_field_active_for')}>
        {formatDuration((end - start) / 1000)}
      </TooltipRow>
      {active ? (
        <TooltipRow label={t('alarm_tooltip_last_activity')}>
          {t('alarm_tooltip_ago', { duration: formatDuration((now - start) / 1000) })}
        </TooltipRow>
      ) : (
        <TooltipRow label={t('alarm_field_normalized')}>{formatClock(end)}</TooltipRow>
      )}
      <OptionalRow label={t('alarm_tooltip_acknowledged')}>{acknowledgedText(alarm, t)}</OptionalRow>
    </CursorTooltip>
  );
};

export default AlarmTooltip;
