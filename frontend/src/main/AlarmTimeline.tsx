import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from 'react-bootstrap';
import { ClockHistory } from 'react-bootstrap-icons';
import AlarmTooltip from './AlarmTooltip';
import RainTooltip from './RainTooltip';
import {
  alarmHeatColor,
  alarmPeakValue,
  alarmRainSpans,
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
  alarmRainSpans,
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

/** Short day label for the day header, e.g. "Mo 18.08.". */
const formatDayLabel = (ms: number): string =>
  new Intl.DateTimeFormat('de-DE', {
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
  })
    .format(new Date(ms))
    .replace(/,/g, '');

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

type RainTooltipState = {
  start: number;
  end: number;
  amount?: number | null;
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
  // Width of the label column (measured from the day-header spacer), used to
  // position the day grid layer over the track area.
  const [labelWidth, setLabelWidth] = useState(0);
  const labelSpacerRef = useRef<HTMLDivElement | null>(null);
  // Manual zoom range set by drag-selecting on a track; null = auto-fit to the alarms.
  const [zoomRange, setZoomRange] = useState<{
    start: number;
    end: number;
  } | null>(null);
  // Live selection rectangle (body-relative px) while drag-zooming.
  const [dragSelection, setDragSelection] = useState<{
    left: number;
    width: number;
  } | null>(null);
  const dragRef = useRef<{
    trackRect: DOMRect;
    startX: number;
    moved: boolean;
  } | null>(null);
  // Hover state: timestamp under the cursor + its x-position (px, relative to
  // the timeline body) for the vertical indicator + bottom date tooltip.
  const [hover, setHover] = useState<{ ms: number; x: number } | null>(null);
  // Floating alarm detail tooltip while hovering a bar.
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  // Floating rain tooltip while hovering a rain overlay.
  const [rainTooltip, setRainTooltip] = useState<RainTooltipState | null>(null);
  const rainCloseTimerRef = useRef<number | null>(null);

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current != null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const clearRainCloseTimer = useCallback(() => {
    if (rainCloseTimerRef.current != null) {
      window.clearTimeout(rainCloseTimerRef.current);
      rainCloseTimerRef.current = null;
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

  // Same grace-period close behavior as the alarm tooltip, for the rain tooltip.
  const scheduleRainTooltipClose = useCallback(() => {
    clearRainCloseTimer();
    rainCloseTimerRef.current = window.setTimeout(() => {
      setRainTooltip(null);
      rainCloseTimerRef.current = null;
    }, TOOLTIP_CLOSE_DELAY_MS);
  }, [clearRainCloseTimer]);

  useEffect(() => clearRainCloseTimer, [clearRainCloseTimer]);

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

  // Measure the label column width (the day-header spacer uses the exact same
  // class as the lane labels, so its width matches the track offset).
  useEffect(() => {
    const node = labelSpacerRef.current;
    if (!node) {
      return;
    }
    const observer = new ResizeObserver(() => {
      setLabelWidth(node.offsetWidth);
    });
    observer.observe(node);
    setLabelWidth(node.offsetWidth);
    return () => observer.disconnect();
  }, []);

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
    if (zoomRange) {
      return { minTime: zoomRange.start, maxTime: zoomRange.end };
    }
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
  }, [spans, now, zoomRange]);

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

  // Day boundaries (local midnight) inside the current axis range. Month
  // starts get a stronger grid line so the days read like a calendar.
  const dayTicks = useMemo(() => {
    const ticks: Array<{ ms: number; monthStart: boolean }> = [];
    const first = new Date(minTime);
    first.setHours(0, 0, 0, 0);
    if (first.getTime() < minTime) {
      first.setDate(first.getDate() + 1);
    }
    const last = new Date(maxTime);
    const cursor = new Date(
      first.getFullYear(),
      first.getMonth(),
      first.getDate(),
    );
    while (cursor.getTime() <= last.getTime()) {
      ticks.push({
        ms: cursor.getTime(),
        monthStart: cursor.getDate() === 1,
      });
      cursor.setDate(cursor.getDate() + 1);
    }
    return ticks;
  }, [minTime, maxTime]);

  // Label only every Nth day so the day labels never overlap; adapts to the
  // zoom level (56px is roughly the width of one day label).
  const dayLabelStep = useMemo(() => {
    const width = trackWidth || 800;
    const pxPerDay = (width / axisSpan) * 86_400_000;
    return Math.max(1, Math.ceil(56 / Math.max(pxPerDay, 1)));
  }, [trackWidth, axisSpan]);

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

  /** Minimum horizontal movement (px) before a mousedown counts as a zoom drag rather than a click. */
  const DRAG_THRESHOLD_PX = 4;

  // Drag-to-zoom: dragging left/right on any track selects a time range and
  // zooms the whole axis to it on release. A plain click (no real movement)
  // is left alone so bar selection still works.
  const handleTrackMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }
    const trackRect = event.currentTarget.getBoundingClientRect();
    const body = bodyRef.current;
    if (!body) {
      return;
    }
    const bodyRect = body.getBoundingClientRect();
    const rangeStart = minTime;
    const rangeEnd = maxTime;
    dragRef.current = { trackRect, startX: event.clientX, moved: false };

    const clampToTrack = (clientX: number) =>
      Math.min(Math.max(clientX, trackRect.left), trackRect.right);

    const toMs = (clientX: number) => {
      const ratio = (clampToTrack(clientX) - trackRect.left) / trackRect.width;
      return rangeStart + ratio * (rangeEnd - rangeStart);
    };

    const handleWindowMouseMove = (moveEvent: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) {
        return;
      }
      if (Math.abs(moveEvent.clientX - drag.startX) > DRAG_THRESHOLD_PX) {
        drag.moved = true;
      }
      const startPx = clampToTrack(drag.startX) - bodyRect.left;
      const currentPx = clampToTrack(moveEvent.clientX) - bodyRect.left;
      setDragSelection({
        left: Math.min(startPx, currentPx),
        width: Math.abs(currentPx - startPx),
      });
    };

    // Suppress the click on whatever's under the cursor (e.g. an alarm bar)
    // when this mousedown turned into a real drag.
    const handleWindowClickCapture = (clickEvent: MouseEvent) => {
      if (dragRef.current?.moved) {
        clickEvent.preventDefault();
        clickEvent.stopPropagation();
      }
    };

    const handleWindowMouseUp = (upEvent: MouseEvent) => {
      window.removeEventListener('mousemove', handleWindowMouseMove);
      const drag = dragRef.current;
      dragRef.current = null;
      setDragSelection(null);
      if (drag?.moved) {
        const msA = toMs(drag.startX);
        const msB = toMs(upEvent.clientX);
        const start = Math.min(msA, msB);
        const end = Math.max(msA, msB);
        // Ignore accidental micro-drags that would zoom into a sliver of time.
        if (end - start > 1000) {
          setZoomRange({ start, end });
        }
      }
    };

    window.addEventListener('mousemove', handleWindowMouseMove);
    window.addEventListener('mouseup', handleWindowMouseUp, { once: true });
    window.addEventListener('click', handleWindowClickCapture, {
      once: true,
      capture: true,
    });
  };

  const resetZoom = () => setZoomRange(null);

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

  const handleRainMouseEnter = (
    rain: { start: number; end: number },
    amount: number | null | undefined,
    event: React.MouseEvent<HTMLDivElement>,
  ) => {
    clearRainCloseTimer();
    // A rain overlay hover shouldn't leave the alarm-bar tooltip lingering.
    scheduleTooltipClose();
    const { x, y } = toBodyPosition(event);
    setRainTooltip({ start: rain.start, end: rain.end, amount, x, y });
  };

  const handleRainMouseMove = (event: React.MouseEvent<HTMLDivElement>) => {
    setRainTooltip((current) => {
      if (!current) {
        return current;
      }
      const { x, y } = toBodyPosition(event);
      return { ...current, x, y };
    });
  };

  const handleRainMouseLeave = () => {
    scheduleRainTooltipClose();
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

        <div className="alarm-timeline-axis d-flex justify-content-between align-items-center small text-muted">
          <span>{formatClock(minTime)}</span>
          <span className="alarm-timeline-zoom-hint">
            🔍 Drag to zoom
            {zoomRange && (
              <button
                type="button"
                className="alarm-timeline-zoom-reset"
                onClick={resetZoom}
              >
                Reset zoom
              </button>
            )}
          </span>
          <span>{formatClock(maxTime)}</span>
        </div>
      </div>

      <div className="alarm-timeline-body" ref={bodyRef}>
        {/* Day header: day labels aligned with the tracks (spacer matches the
            lane label column, so labels line up with the time axis). */}
        <div className="alarm-timeline-day-header">
          <div className="alarm-timeline-label" ref={labelSpacerRef} />
          <div className="alarm-timeline-day-header-track">
            {dayTicks.map((tick, index) =>
              index % dayLabelStep === 0 ? (
                <span
                  key={tick.ms}
                  className="alarm-timeline-day-label"
                  style={{ left: `${toLeft(tick.ms)}%` }}
                >
                  {formatDayLabel(tick.ms)}
                </span>
              ) : null,
            )}
          </div>
        </div>

        {/* Day grid: one vertical line per day boundary across all lanes. */}
        {labelWidth > 0 && dayTicks.length > 0 && (
          <div className="alarm-timeline-grid" style={{ left: labelWidth }}>
            {dayTicks.map((tick) => (
              <div
                key={`line-${tick.ms}`}
                className={
                  tick.monthStart
                    ? 'alarm-timeline-grid-line is-month'
                    : 'alarm-timeline-grid-line'
                }
                style={{ left: `${toLeft(tick.ms)}%` }}
              />
            ))}
          </div>
        )}

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
                  onMouseDown={handleTrackMouseDown}
                  onMouseMove={handleTrackMouseMove}
                  onMouseLeave={handleTrackMouseLeave}
                >
                  {group.spans
                    .slice()
                    .sort((a, b) => a.start - b.start)
                    .flatMap((span) =>
                      alarmRainSpans(span.alarm).map((rain, index) => ({
                        span,
                        rain,
                        index,
                      })),
                    )
                    .map(({ span, rain, index }) => (
                      <div
                        key={`rain-${span.alarm.id}-${index}`}
                        className="alarm-timeline-rain"
                        style={{
                          left: `${toLeft(rain.start)}%`,
                          width: `${toWidth(rain.end - rain.start)}%`,
                        }}
                        onMouseEnter={(event) =>
                          handleRainMouseEnter(rain, rain.amount, event)
                        }
                        onMouseMove={handleRainMouseMove}
                        onMouseLeave={handleRainMouseLeave}
                      >
                        {rain.amount != null && (
                          <span className="alarm-timeline-rain-label">
                            💧{Math.round(rain.amount * 10) / 10}mm
                          </span>
                        )}
                      </div>
                    ))}
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

        {dragSelection && (
          <div
            className="alarm-timeline-drag-selection"
            style={{ left: dragSelection.left, width: dragSelection.width }}
          />
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

        {rainTooltip && (
          <RainTooltip
            start={rainTooltip.start}
            end={rainTooltip.end}
            amount={rainTooltip.amount}
            x={rainTooltip.x + 15}
            y={rainTooltip.y + 15}
            containerWidth={bodyRef.current?.clientWidth ?? 0}
            containerHeight={bodyRef.current?.clientHeight ?? 0}
            onMouseEnter={clearRainCloseTimer}
            onMouseLeave={scheduleRainTooltipClose}
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
