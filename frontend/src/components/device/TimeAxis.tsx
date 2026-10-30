import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { dateLocale, PRETTY_LOCALE } from '../../main/dateFormat';
import { timeTicks } from './timeTicks';
import './TimeAxis.css';

type TimeAxisProps = {
  from: number;
  to: number;
  /** Where a moment sits on the axis (0..1); linear between from and to by default. */
  position?: (ms: number) => number;
};

/** Room per label (px): decides how fine the marks get. */
const LABEL_SPACING = 78;

/**
 * Calendar marks under a time slider - hours, days, weeks, months or years,
 * as fine as the width allows (see timeTicks). Midnights, first days of a
 * month and new years are drawn stronger.
 */
const TimeAxis = ({ from, to, position }: TimeAxisProps) => {
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

  const ticks = useMemo(
    () =>
      timeTicks(
        from,
        to,
        Math.max(2, Math.floor((width || 600) / LABEL_SPACING)),
        dateLocale(i18n.language) ?? PRETTY_LOCALE,
      ),
    [from, to, width, i18n.language],
  );
  const at = position ?? ((ms: number) => (ms - from) / (to - from));

  return (
    <div className="time-axis" ref={ref} aria-hidden="true">
      {ticks.map((tick) => {
        const fraction = at(tick.ms);
        if (!(fraction >= 0 && fraction <= 1)) {
          return null;
        }
        // Labels at the very ends stay inside the axis.
        const align = fraction < 0.04 ? 'start' : fraction > 0.96 ? 'end' : 'center';
        return (
          <span
            key={tick.ms}
            className={`time-axis__tick time-axis__tick--${align}${tick.major ? ' is-major' : ''}`}
            style={{ left: `${fraction * 100}%` }}
          >
            <span className="time-axis__label">{tick.label}</span>
          </span>
        );
      })}
    </div>
  );
};

export default TimeAxis;
