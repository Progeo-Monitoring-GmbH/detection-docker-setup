import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from 'react-bootstrap';
import { ClockHistory } from 'react-bootstrap-icons';
import AlarmTooltip from './AlarmTooltip';
import {
  alarmHeatColor,
  alarmPeakValue,
  alarmStartTime,
  formatDuration,
  isAlarmActive,
  parseTimestamp,
  type TimelineAlarm,
} from './alarmUtils';
import './AlarmTimeline.css';

export {
  alarmHeatColor,
  alarmPeakValue,
  alarmStartTime,
  formatDuration,
  isAlarmActive,
  parseTimestamp,
  type AlarmDeviceLite,
  type AlarmLocationLite,
  type AlarmMaxValueEntry,
  type TimelineAlarm,
} from './alarmUtils';

type AlarmTimelineProps = {
  alarms: TimelineAlarm[];
  /** Current wall-clock time in ms — active alarms extend to this value. */
  now: number;
  selectedAlarmId?: number | null;
  onSelectAlarm?: (alarm: TimelineAlarm) => void;
};

/** Close delay for the floating alarm tooltip after the mouse left it (ms). */
const TOOLTIP_CLOSE_DELAY_MS = 250;

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

type AlarmSpan = {
  alarm: TimelineAlarm;
  start: number;
  end: number;
};

type TooltipState = {
  alarm: TimelineAlarm;
  start: number;
  end: number;
  x: number;
  y: number;
};

const AlarmTimeline = ({
  alarms,
  now,
  selectedAlarmId = null,
  onSelectAlarm,
}: AlarmTimelineProps) => {
  const [sortBy, setSortBy] = useState<'label' | 'duration' | 'max_value'>(
    'duration',
  );
  const [trackWidth, setTrackWidth] = useState(0);
  const trackObserver = useRef<ResizeObserver | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // Hover state: timestamp under the cursor + its x-position (px, relative to
  // the timeline body) for the vertical indicator + bottom date tooltip.
  const [hover, setHover] = useState<{ ms: number; x: number } | null>(null);
  // Floating alarm detail tooltip while hovering a bar.
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const closeTimerRef = useRef<number | null>(null);

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current != null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  // Close the tooltip 2s after the mouse left it (or a bar), unless the mouse
  // re-enters the tooltip/another bar before the timer fires.
  const scheduleTooltipClose = useCallback(() => {
    clearCloseTimer();
    closeTimerRef.current = window.setTimeout(() => {
      setTooltip(null);
      closeTimerRef.current = null;
    }, TOOLTIP_CLOSE_DELAY_MS);
  }, [clearCloseTimer]);

  useEffect(() => clearCloseTimer, [clearCloseTimer]);

  // Measure the track so we can decide whether a bar is wide enough to draw
  // its duration/max-value label inside it. All lanes share the same track
  // width, so we re-observe whichever track is currently mounted.
  const trackRef = useCallback((node: HTMLDivElement | null) => {
    trackObserver.current?.disconnect();
    trackObserver.current = null;
    if (!node) {
      setTrackWidth(0);
      return;
    }
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setTrackWidth(entry.contentRect.width);
      }
    });
    observer.observe(node);
    trackObserver.current = observer;
  }, []);

  useEffect(
    () => () => {
      trackObserver.current?.disconnect();
      trackObserver.current = null;
    },
    [],
  );

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
    const entries = [...map.values()];
    if (sortBy === 'duration') {
      // Sort by total active time, descending (longest-running first).
      entries.sort((a, b) => {
        const durationA = a.spans.reduce(
          (sum, span) => sum + (span.end - span.start),
          0,
        );
        const durationB = b.spans.reduce(
          (sum, span) => sum + (span.end - span.start),
          0,
        );
        return durationB - durationA;
      });
    } else if (sortBy === 'max_value') {
      // Sort by the highest recorded value, descending.
      entries.sort((a, b) => {
        const peakA = Math.max(
          ...a.spans.map((span) => alarmPeakValue(span.alarm) ?? 0),
          0,
        );
        const peakB = Math.max(
          ...b.spans.map((span) => alarmPeakValue(span.alarm) ?? 0),
          0,
        );
        return peakB - peakA;
      });
    } else {
      entries.sort((a, b) => a.label.localeCompare(b.label));
    }
    return entries;
  }, [spans, sortBy]);

  const axisSpan = Math.max(maxTime - minTime, 1);
  const toLeft = (ms: number) => ((ms - minTime) / axisSpan) * 100;
  const toWidth = (ms: number) => Math.max((ms / axisSpan) * 100, 0.35);

  // Map a mouse x-position (relative to the track) to a timestamp and keep
  // the x-offset relative to the timeline body for the hover indicator.
  const handleTrackMouseMove = (event: React.MouseEvent<HTMLDivElement>) => {
    const body = bodyRef.current;
    if (!body) {
      return;
    }
    const trackRect = event.currentTarget.getBoundingClientRect();
    const xInTrack = event.clientX - trackRect.left;
    const ratio = Math.min(1, Math.max(0, xInTrack / trackRect.width));
    const ms = minTime + ratio * (maxTime - minTime);
    const xInBody =
      trackRect.left - body.getBoundingClientRect().left + xInTrack;
    setHover({ ms, x: xInBody });
  };

  const handleTrackMouseLeave = () => {
    setHover(null);
    // The mouse left the whole timeline, so the alarm tooltip should go away
    // (after the usual grace period, in case it moved onto the tooltip).
    scheduleTooltipClose();
  };

  // Open/move the floating alarm tooltip for the bar under the cursor. A new
  // bar replaces the previous tooltip immediately ("closes when another
  // component is opened") and cancels any pending close timer.
  const toBodyPosition = (
    event: React.MouseEvent<HTMLDivElement>,
  ): { x: number; y: number } => {
    const body = bodyRef.current;
    const rect = body?.getBoundingClientRect();
    if (!rect) {
      return { x: event.clientX, y: event.clientY };
    }
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
  };

  const handleBarMouseEnter = (
    span: AlarmSpan,
    event: React.MouseEvent<HTMLDivElement>,
  ) => {
    clearCloseTimer();
    const { x, y } = toBodyPosition(event);
    setTooltip({
      alarm: span.alarm,
      start: span.start,
      end: span.end,
      x,
      y,
    });
  };

  const handleBarMouseMove = (event: React.MouseEvent<HTMLDivElement>) => {
    setTooltip((current) => {
      if (!current) {
        return current;
      }
      const { x, y } = toBodyPosition(event);
      return { ...current, x, y };
    });
  };

  const handleBarMouseLeave = () => {
    // Keep the tooltip visible for a short grace period so the user can move
    // the mouse onto it (e.g. to click "Open alarm details").
    scheduleTooltipClose();
  };

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
    <div className="alarm-timeline">
      <div className="alarm-timeline-header">
        <div className="alarm-timeline-summary d-flex flex-wrap gap-3 align-items-center">
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
          <div className="ms-auto">
            <select
              className="form-select form-select-sm"
              aria-label="Sort timeline"
              value={sortBy}
              onChange={(event) =>
                setSortBy(
                  event.target.value as 'label' | 'duration' | 'max_value',
                )
              }
            >
              <option value="duration">Sort by active time</option>
              <option value="max_value">Sort by max value</option>
              <option value="label">Sort by name</option>
            </select>
          </div>
        </div>

        <div className="alarm-timeline-axis d-flex justify-content-between small text-muted">
          <span>{formatClock(minTime)}</span>
          <span>{formatClock(maxTime)}</span>
        </div>
      </div>

      <div className="alarm-timeline-body" ref={bodyRef}>
        <div className="alarm-timeline-scroll">
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
                  <div
                    className="alarm-timeline-label-name"
                    title={group.label}
                  >
                    {group.label}
                  </div>
                  <div className="alarm-timeline-label-stats small text-muted">
                    {group.spans.length} alarm(s) · {groupActiveCount} active ·{' '}
                    {formatDuration(groupDurationSeconds)}
                  </div>
                </div>
                <div
                  className="alarm-timeline-track"
                  ref={trackRef}
                  onMouseMove={handleTrackMouseMove}
                  onMouseLeave={handleTrackMouseLeave}
                >
                  {group.spans
                    .slice()
                    .sort((a, b) => a.start - b.start)
                    .map((span) => {
                      const isSelected = span.alarm.id === selectedAlarmId;
                      const isActive = isAlarmActive(span.alarm);
                      const heatColor = alarmHeatColor(span.alarm);
                      const barWidthPercent = toWidth(span.end - span.start);
                      const barWidthPx = (barWidthPercent / 100) * trackWidth;
                      const showLabel = barWidthPx >= 90;
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
                            width: `${barWidthPercent}%`,
                            background: heatColor,
                          }}
                          onMouseEnter={(event) =>
                            handleBarMouseEnter(span, event)
                          }
                          onMouseMove={handleBarMouseMove}
                          onMouseLeave={handleBarMouseLeave}
                          onClick={() => onSelectAlarm?.(span.alarm)}
                        >
                          {showLabel && (
                            <span className="alarm-timeline-bar-label">
                              {formatDuration((span.end - span.start) / 1000)}
                              {span.alarm.max_value != null
                                ? ` · ${span.alarm.max_value / span.alarm.threshold! >= 1.5 ? '🔥 ' : ''}${Math.round((span.alarm.max_value / span.alarm?.threshold!) * 100) / 100}x`
                                : ''}
                            </span>
                          )}
                        </div>
                      );
                    })}
                </div>
              </div>
            );
          })}
        </div>

        {hover && (
          <>
            <div
              className="alarm-timeline-hover-line"
              style={{ left: hover.x }}
            />
            <div className="alarm-timeline-hover-tip" style={{ left: hover.x }}>
              {formatClock(hover.ms)}
            </div>
          </>
        )}

        {tooltip && (
          <AlarmTooltip
            alarm={tooltip.alarm}
            start={tooltip.start}
            end={tooltip.end}
            now={now}
            x={tooltip.x + 15}
            y={tooltip.y + 15}
            containerWidth={bodyRef.current?.clientWidth ?? 0}
            containerHeight={bodyRef.current?.clientHeight ?? 0}
            onMouseEnter={clearCloseTimer}
            onMouseLeave={scheduleTooltipClose}
          />
        )}
      </div>

      <div className="alarm-timeline-legend d-flex gap-3 mt-2 small text-muted">
        <span className="d-flex align-items-center gap-1">
          <span className="alarm-timeline-swatch alarm-timeline-swatch-border-red" />
          Still active
        </span>
        <span className="d-flex align-items-center gap-1">
          <span className="alarm-timeline-swatch alarm-timeline-swatch-border-green" />
          Normalized
        </span>
        <span className="d-flex align-items-center gap-1">
          <span className="alarm-timeline-swatch alarm-timeline-swatch-heat" />
          Heat (max value vs. threshold)
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
