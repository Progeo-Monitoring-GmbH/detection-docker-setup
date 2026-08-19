import { useMemo } from 'react';
import { Badge } from 'react-bootstrap';
import { ClockHistory } from 'react-bootstrap-icons';
import './AlarmTimeline.css';

export type AlarmLocationLite = {
  id?: number | null;
  project_id?: number | null;
  name?: string | null;
};

export type AlarmDeviceLite = {
  id?: number | null;
  mac?: string | null;
  raw_hash?: string | null;
};

export type TimelineAlarm = {
  id: number;
  location?: AlarmLocationLite | null;
  device?: AlarmDeviceLite | null;
  triggered_at?: string | null;
  last_fetched?: string | null;
  last_updated?: string | null;
  normalized_at?: string | null;
  still_active_at?: string | null;
  evaluated_at?: string | null;
  evaluated_by?: { id?: number | null; username?: string | null } | null;
  is_active?: boolean;
  status?: number;
  sensor_id?: number | null;
  max_value?: number | null;
  threshold?: number | null;
};

type AlarmTimelineProps = {
  alarms: TimelineAlarm[];
  /** Current wall-clock time in ms — active alarms extend to this value. */
  now: number;
  selectedAlarmId?: number | null;
  onSelectAlarm?: (alarm: TimelineAlarm) => void;
};

/** Format a duration in seconds as "1d 2h 3m 4s" (skips empty units). */
export const formatDuration = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '-';
  }
  const total = Math.floor(seconds);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (parts.length === 0 || secs > 0) parts.push(`${secs}s`);
  return parts.join(' ');
};

export const parseTimestamp = (raw?: string | null): number | null => {
  if (!raw) {
    return null;
  }
  // ISO-8601 (preferred, emitted by ProgeoAlarmSerializer).
  const ms = Date.parse(raw);
  if (!Number.isNaN(ms)) {
    return ms;
  }
  // Fallback: the project-wide pretty format "%d.%m.%Y, %H:%M" (e.g.
  // "19.08.2026, 11:08") in case a stale/cached payload shows up.
  const prettyMatch =
    /^(\d{2})\.(\d{2})\.(\d{4}),\s*(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(
      raw.trim(),
    );
  if (prettyMatch) {
    const [, day, month, year, hour, minute, second] = prettyMatch;
    const date = new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      second ? Number(second) : 0,
    );
    return Number.isNaN(date.getTime()) ? null : date.getTime();
  }
  return null;
};

/**
 * Effective alarm start time in ms. `triggered_at` is the canonical trigger
 * time, but legacy alarms may lack it - fall back to the alarm row's own
 * `last_fetched`/`last_updated` (set whenever the row is saved) so the alarm
 * always gets a position on the timeline.
 */
export const alarmStartTime = (alarm: {
  triggered_at?: string | null;
  last_fetched?: string | null;
  last_updated?: string | null;
}): number | null => {
  return (
    parseTimestamp(alarm.triggered_at) ??
    parseTimestamp(alarm.last_fetched) ??
    parseTimestamp(alarm.last_updated)
  );
};

/**
 * Whether the alarm is still active. Prefers the backend `is_active` flag and
 * falls back to deriving it from `normalized_at` so the UI stays correct even
 * when the payload does not include the flag.
 */
export const isAlarmActive = (alarm: {
  is_active?: boolean | null;
  normalized_at?: string | null;
}): boolean => {
  if (typeof alarm.is_active === 'boolean') {
    return alarm.is_active;
  }
  return parseTimestamp(alarm.normalized_at) == null;
};

type AlarmSpan = {
  alarm: TimelineAlarm;
  start: number;
  end: number;
};

const formatClock = (ms: number): string =>
  new Date(ms).toLocaleString(undefined, {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

const locationKey = (alarm: TimelineAlarm): string => {
  const loc = alarm.location;
  if (loc?.id != null) {
    return `loc-${loc.id}`;
  }
  if (loc?.project_id != null) {
    return `proj-${loc.project_id}`;
  }
  return 'unknown';
};

const locationLabel = (alarm: TimelineAlarm): string => {
  const loc = alarm.location;
  if (loc?.name) {
    return loc.name;
  }
  if (loc?.project_id != null) {
    return `Project ${loc.project_id}`;
  }
  return 'Unknown location';
};

const AlarmTimeline = ({
  alarms,
  now,
  selectedAlarmId = null,
  onSelectAlarm,
}: AlarmTimelineProps) => {
  const spans = useMemo<AlarmSpan[]>(() => {
    const result: AlarmSpan[] = [];
    for (const alarm of alarms) {
      const start = alarmStartTime(alarm);
      if (start == null) {
        continue;
      }
      const normalized = parseTimestamp(alarm.normalized_at);
      const active = isAlarmActive(alarm);
      const end = normalized != null ? normalized : active ? now : start;
      result.push({ alarm, start, end: Math.max(end, start) });
    }
    return result;
  }, [alarms, now]);

  const { minTime, maxTime } = useMemo(() => {
    if (spans.length === 0) {
      return { minTime: 0, maxTime: 1 };
    }
    let minTime = Math.min(...spans.map((span) => span.start));
    let maxTime = Math.max(...spans.map((span) => span.end), now);
    // Pad the axis so single-point alarms still render a visible bar.
    const spanMs = maxTime - minTime;
    if (spanMs <= 0) {
      minTime -= 3_600_000;
      maxTime += 3_600_000;
    } else {
      minTime -= spanMs * 0.04;
      maxTime += spanMs * 0.04;
    }
    return { minTime, maxTime };
  }, [spans, now]);

  const groups = useMemo(() => {
    const map = new Map<
      string,
      { key: string; label: string; spans: AlarmSpan[] }
    >();
    for (const span of spans) {
      const key = locationKey(span.alarm);
      if (!map.has(key)) {
        map.set(key, { key, label: locationLabel(span.alarm), spans: [] });
      }
      map.get(key)!.spans.push(span);
    }
    return [...map.values()];
  }, [spans]);

  const axisSpan = Math.max(maxTime - minTime, 1);
  const toLeft = (ms: number) => ((ms - minTime) / axisSpan) * 100;
  const toWidth = (ms: number) => Math.max((ms / axisSpan) * 100, 0.35);

  const totalDurationSeconds = useMemo(
    () => spans.reduce((sum, span) => sum + (span.end - span.start) / 1000, 0),
    [spans],
  );
  const activeCount = useMemo(
    () => alarms.filter((alarm) => isAlarmActive(alarm)).length,
    [alarms],
  );

  if (spans.length === 0) {
    return (
      <div className="alarm-timeline-empty">
        <ClockHistory className="me-2 text-muted" />
        No alarms to display on the timeline.
      </div>
    );
  }

  return (
    <div className="alarm-timeline p-2">
      <div className="alarm-timeline-summary d-flex flex-wrap gap-3 mb-2">
        <span className="text-muted small">
          <strong>{spans.length}</strong> alarm(s)
        </span>
        <span className="text-muted small">
          <strong>{activeCount}</strong> active
        </span>
        <span className="text-muted small">
          Total active time:{' '}
          <strong>{formatDuration(totalDurationSeconds)}</strong>
        </span>
        <span className="text-muted small">
          <strong>{groups.length}</strong> location(s)
        </span>
      </div>

      <div className="alarm-timeline-axis d-flex justify-content-between small text-muted">
        <span>{formatClock(minTime)}</span>
        <span>{formatClock(maxTime)}</span>
      </div>

      {groups.map((group) => {
        const groupDurationSeconds = group.spans.reduce(
          (sum, span) => sum + (span.end - span.start) / 1000,
          0,
        );
        const groupActiveCount = group.spans.filter((span) =>
          isAlarmActive(span.alarm),
        ).length;
        return (
          <div className="alarm-timeline-lane" key={group.key}>
            <div className="alarm-timeline-label">
              <div className="alarm-timeline-label-name" title={group.label}>
                {group.label}
              </div>
              <div className="alarm-timeline-label-stats small text-muted">
                {group.spans.length} alarm(s) · {groupActiveCount} active ·{' '}
                {formatDuration(groupDurationSeconds)}
              </div>
            </div>
            <div className="alarm-timeline-track">
              {group.spans
                .slice()
                .sort((a, b) => a.start - b.start)
                .map((span) => {
                  const isSelected = span.alarm.id === selectedAlarmId;
                  const isActive = isAlarmActive(span.alarm);
                  return (
                    <div
                      key={span.alarm.id}
                      className={[
                        'alarm-timeline-bar',
                        isActive ? 'is-active' : 'is-normalized',
                        isSelected ? 'is-selected' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      style={{
                        left: `${toLeft(span.start)}%`,
                        width: `${toWidth(span.end - span.start)}%`,
                      }}
                      title={[
                        `Alarm #${span.alarm.id}`,
                        span.alarm.device?.mac || span.alarm.device?.raw_hash
                          ? `Device: ${span.alarm.device?.mac || span.alarm.device?.raw_hash}`
                          : '',
                        span.alarm.sensor_id != null
                          ? `Sensor: ${span.alarm.sensor_id}`
                          : '',
                        `Triggered: ${new Date(span.start).toLocaleString()}`,
                        isActive
                          ? `Still active · running ${formatDuration(
                              (now - span.start) / 1000,
                            )}`
                          : `Normalized: ${new Date(span.end).toLocaleString()}`,
                        `Active for: ${formatDuration(
                          (span.end - span.start) / 1000,
                        )}`,
                        span.alarm.status === 1
                          ? `Acknowledged by ${
                              span.alarm.evaluated_by?.username || 'unknown'
                            } · ${
                              span.alarm.evaluated_at
                                ? new Date(
                                    span.alarm.evaluated_at,
                                  ).toLocaleString()
                                : '-'
                            }`
                          : '',
                      ]
                        .filter(Boolean)
                        .join('\n')}
                      onClick={() => onSelectAlarm?.(span.alarm)}
                    />
                  );
                })}
            </div>
          </div>
        );
      })}

      <div className="alarm-timeline-legend d-flex gap-3 mt-2 small text-muted">
        <span className="d-flex align-items-center gap-1">
          <Badge bg="danger" pill>
            &nbsp;
          </Badge>{' '}
          Active
        </span>
        <span className="d-flex align-items-center gap-1">
          <Badge bg="success" pill>
            &nbsp;
          </Badge>{' '}
          Normalized
        </span>
        <span className="d-flex align-items-center gap-1">
          <Badge bg="primary" pill>
            &nbsp;
          </Badge>{' '}
          Selected
        </span>
        <span className="ms-auto">Click a bar to load its heatmap</span>
      </div>
    </div>
  );
};

export default AlarmTimeline;
