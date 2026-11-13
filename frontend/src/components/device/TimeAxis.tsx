import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { dateLocale, PRETTY_LOCALE } from '../../main/dateFormat';
import { frameAxisLabels } from './timeTicks';
import { childTestId } from '../../testIds';
import './TimeAxis.css';

type TimeAxisProps = {
  from: number;
  to: number;
  /** The time (ms) at a place on the axis (0..1); linear between from and to by default. */
  timeAt?: (fraction: number) => number;
  /** data-testid of the axis; its labels are "<testId>-label" (key: the label's time in ms). */
  testId?: string;
};

/**
 * The time labels under a frame slider: evenly spread from its first to
 * its last frame, as many as fit without overlapping (see frameAxisLabels).
 */
const TimeAxis = ({ from, to, timeAt, testId = 'time-axis' }: TimeAxisProps) => {
  const { i18n } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return undefined;
    }
    setWidth(element.getBoundingClientRect().width);
    if (typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const labels = useMemo(
    () =>
      frameAxisLabels({
        from,
        to,
        width: width || 600,
        timeAt,
        locale: dateLocale(i18n.language) ?? PRETTY_LOCALE,
      }),
    [from, to, width, timeAt, i18n.language],
  );

  return (
    <div className="time-axis" ref={ref} aria-hidden="true" data-testid={testId}>
      {labels.map(({ fraction, ms, label }) => (
        <span key={`${fraction}:${ms}`} className="time-axis__tick" style={{ left: `${fraction * 100}%` }}>
          {/* Anchored at `fraction` of its width: the first label starts at
              the axis' start, the last ends at its end, all evenly spaced. */}
          <span
            className="time-axis__label"
            style={{ transform: `translateX(${-fraction * 100}%)` }}
            data-testid={childTestId(testId, 'label')}
            data-test-key={`${fraction}:${ms}`}
          >
            {label}
          </span>
        </span>
      ))}
    </div>
  );
};

export default TimeAxis;
