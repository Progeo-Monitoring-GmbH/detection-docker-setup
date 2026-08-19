import { useLayoutEffect, useRef, useState } from 'react';
import { Button } from 'react-bootstrap';
import { ArrowRightCircle } from 'react-bootstrap-icons';
import { useNavigate } from 'react-router';
import {
  alarmHeatColor,
  alarmPeakValue,
  formatDuration,
  isAlarmActive,
  parseTimestamp,
  type TimelineAlarm,
} from './alarmUtils';
import './AlarmTooltip.css';

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

  const active = isAlarmActive(alarm);
  const heatColor = alarmHeatColor(alarm);
  const peak = alarmPeakValue(alarm);
  const locationId = alarm.location?.id ?? alarm.location?.project_id ?? null;

  const width = size?.width ?? 260;
  const height = size?.height ?? 0;

  // Horizontally center the tooltip on the cursor, clamped to the container.
  const left = Math.min(
    Math.max(x, width / 2 + EDGE_MARGIN_PX),
    Math.max(containerWidth - width / 2 - EDGE_MARGIN_PX, width / 2 + EDGE_MARGIN_PX),
  );

  // Prefer drawing above the cursor; flip below when it would clip the top.
  let top = y - height - CURSOR_GAP_PX;
  if (top < EDGE_MARGIN_PX) {
    top = y + CURSOR_GAP_PX;
  }
  const maxTop = Math.max(EDGE_MARGIN_PX, containerHeight - height - EDGE_MARGIN_PX);
  top = Math.min(Math.max(top, EDGE_MARGIN_PX), maxTop);

  const openDetails = () => {
    if (locationId != null) {
      navigate(`/location/${locationId}/alarms`);
    }
  };

  return (
    <div
      ref={tooltipRef}
      className="alarm-tooltip"
      style={{ left, top }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="alarm-tooltip-head">
        <span
          className="alarm-tooltip-dot"
          style={{
            background: heatColor,
            borderColor: active ? '#dc3545' : '#198754',
          }}
        />
        <span className="alarm-tooltip-title">Alarm #{alarm.id}</span>
        <span
          className={[
            'badge',
            active ? 'text-bg-danger' : 'text-bg-success',
          ].join(' ')}
        >
          {active ? 'Still active' : 'Normalized'}
        </span>
      </div>

      <div className="alarm-tooltip-body">
        {alarm.location?.name && (
          <div className="alarm-tooltip-row">
            <span className="alarm-tooltip-key">Location</span>
            <span className="alarm-tooltip-value">{alarm.location.name}</span>
          </div>
        )}
        {(alarm.device?.mac || alarm.device?.raw_hash) && (
          <div className="alarm-tooltip-row">
            <span className="alarm-tooltip-key">Device</span>
            <span className="alarm-tooltip-value">
              {alarm.device?.mac || alarm.device?.raw_hash}
            </span>
          </div>
        )}
        {alarm.sensor_id != null && (
          <div className="alarm-tooltip-row">
            <span className="alarm-tooltip-key">Sensor</span>
            <span className="alarm-tooltip-value">{alarm.sensor_id}</span>
          </div>
        )}
        {peak != null && (
          <div className="alarm-tooltip-row">
            <span className="alarm-tooltip-key">Max value</span>
            <span className="alarm-tooltip-value">{peak}</span>
          </div>
        )}
        <div className="alarm-tooltip-row">
          <span className="alarm-tooltip-key">Triggered</span>
          <span className="alarm-tooltip-value">{formatClock(start)}</span>
        </div>
        <div className="alarm-tooltip-row">
          <span className="alarm-tooltip-key">
            {active ? 'Running for' : 'Active for'}
          </span>
          <span className="alarm-tooltip-value">
            {formatDuration((end - start) / 1000)}
          </span>
        </div>
        {active ? (
          <div className="alarm-tooltip-row">
            <span className="alarm-tooltip-key">Last activity</span>
            <span className="alarm-tooltip-value">
              {formatDuration((now - start) / 1000)} ago
            </span>
          </div>
        ) : (
          <div className="alarm-tooltip-row">
            <span className="alarm-tooltip-key">Normalized</span>
            <span className="alarm-tooltip-value">{formatClock(end)}</span>
          </div>
        )}
        {alarm.status === 1 && (
          <div className="alarm-tooltip-row">
            <span className="alarm-tooltip-key">Acknowledged</span>
            <span className="alarm-tooltip-value">
              {alarm.evaluated_by?.username || 'unknown'}
              {parseTimestamp(alarm.evaluated_at) != null
                ? ` · ${formatClock(parseTimestamp(alarm.evaluated_at)!)}`
                : ''}
            </span>
          </div>
        )}
      </div>

      {locationId != null && (
        <div className="alarm-tooltip-actions">
          <Button
            size="sm"
            variant="primary"
            onClick={openDetails}
            className="w-100"
          >
            <ArrowRightCircle className="me-1" />
            Open alarm details
          </Button>
        </div>
      )}
    </div>
  );
};

export default AlarmTooltip;
