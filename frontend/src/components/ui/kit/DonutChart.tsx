import type { ReactNode } from 'react';
import { childTestId, repeatedTestId } from '../../../testIds';
import './DonutChart.css';

export type DonutSlice = {
  key: string;
  label: string;
  /** The slice's amount (a count, bytes, ...). */
  count: number;
  color: string;
  /** Before the label in the legend (e.g. a status icon - colour never alone). */
  icon?: ReactNode;
};

/**
 * A compact donut with its legend beside it (name, amount and share per
 * slice); slices and legend entries are clickable with `onSelect`. Slices
 * are parted by a 2px gap in the panel colour.
 */
const DonutChart = ({
  slices,
  centerLabel,
  ariaLabel,
  onSelect,
  selectTitle,
  formatValue = String,
  emptyLabel,
  testId,
}: {
  slices: DonutSlice[];
  centerLabel: string;
  ariaLabel: string;
  onSelect?: (key: string) => void;
  selectTitle?: string;
  /** The amounts as shown (centre total, legend, slice titles). */
  formatValue?: (value: number) => string;
  /** Shown instead of the chart when every slice is 0. */
  emptyLabel: ReactNode;
  /** data-testid of the chart; slices "-slice", legend entries "-legend-item" (key: the slice key). */
  testId: string;
}) => {
  const shown = slices.filter((slice) => slice.count > 0);
  const total = shown.reduce((sum, slice) => sum + slice.count, 0);
  if (total <= 0) {
    return (
      <div className="small text-muted py-2" data-testid={childTestId(testId, 'empty')}>
        {emptyLabel}
      </div>
    );
  }

  const center = 60;
  const radius = 54;
  const point = (value: number) => [center + radius * Math.cos(value), center + radius * Math.sin(value)] as const;
  // Start angle of each slice: the sum of the ones before, from 12 o'clock.
  const starts = shown.map(
    (_, index) => -Math.PI / 2 + (shown.slice(0, index).reduce((sum, slice) => sum + slice.count, 0) / total) * Math.PI * 2,
  );
  const segments = shown.map((slice, index) => {
    const sweep = (slice.count / total) * Math.PI * 2;
    const [x1, y1] = point(starts[index]);
    const [x2, y2] = point(starts[index] + sweep);
    return {
      slice,
      percent: Math.round((slice.count / total) * 100),
      // A single slice is a full circle.
      path:
        shown.length === 1
          ? null
          : `M ${center} ${center} L ${x1} ${y1} A ${radius} ${radius} 0 ${sweep > Math.PI ? 1 : 0} 1 ${x2} ${y2} Z`,
    };
  });
  const clickable = onSelect ? 'progeo-donut-clickable' : undefined;

  return (
    <div className="d-flex align-items-center gap-3" data-testid={testId}>
      <svg width={130} height={130} viewBox="0 0 120 120" role="img" aria-label={ariaLabel} className="progeo-donut">
        {segments.map(({ slice, percent, path }) => {
          const title = (
            <title>
              {slice.label}: {formatValue(slice.count)} · {percent}%
            </title>
          );
          return path ? (
            <path
              key={slice.key}
              d={path}
              fill={slice.color}
              stroke="var(--progeo-panel-bg)"
              strokeWidth={2}
              className={clickable}
              onClick={() => onSelect?.(slice.key)}
              {...repeatedTestId(`${testId}-slice`, slice.key)}
            >
              {title}
            </path>
          ) : (
            <circle
              key={slice.key}
              cx={center}
              cy={center}
              r={radius}
              fill={slice.color}
              className={clickable}
              onClick={() => onSelect?.(slice.key)}
              {...repeatedTestId(`${testId}-slice`, slice.key)}
            >
              {title}
            </circle>
          );
        })}
        <circle cx={center} cy={center} r={31} fill="var(--progeo-panel-bg)" pointerEvents="none" />
        <text x={center} y={center + 1} textAnchor="middle" className="progeo-donut-total" data-testid={childTestId(testId, 'total')}>
          {formatValue(total)}
        </text>
        <text x={center} y={center + 14} textAnchor="middle" className="progeo-donut-label">
          {centerLabel}
        </text>
      </svg>
      <div className="d-flex flex-column progeo-donut-legend">
        {segments.map(({ slice, percent }) => (
          <button
            key={slice.key}
            type="button"
            disabled={!onSelect}
            onClick={() => onSelect?.(slice.key)}
            title={selectTitle}
            className={onSelect ? 'progeo-donut-legend-item progeo-donut-legend-item--clickable' : 'progeo-donut-legend-item'}
            {...repeatedTestId(`${testId}-legend-item`, slice.key)}
          >
            <span className="progeo-donut-swatch" style={{ background: slice.color }} />
            {slice.icon}
            <span className="text-truncate">{slice.label}</span>
            <span className="ms-auto text-muted progeo-donut-amount">
              {formatValue(slice.count)} · {percent}%
            </span>
          </button>
        ))}
      </div>
    </div>
  );
};

export default DonutChart;
