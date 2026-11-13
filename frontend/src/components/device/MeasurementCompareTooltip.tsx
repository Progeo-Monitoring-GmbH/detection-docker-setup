import { type CSSProperties, Fragment, type Ref } from 'react';
import { childTestId } from '../../testIds';
import './MeasurementCompareTooltip.css';

type CompareTooltipRow = {
  /** The trace's uid. */
  key: string;
  name: string;
  value: string;
  color: string;
  /** A filled band (square swatch) instead of a line. */
  band?: boolean;
};

export type CompareTooltipData = {
  title: string;
  subtitle?: string | null;
  rows: CompareTooltipRow[];
};

/** The trace's colour (per row) - the swatch's shape comes from its class. */
const swatchStyle = (row: CompareTooltipRow): CSSProperties =>
  row.band ? { background: row.color, borderColor: row.color } : { background: row.color };

export const TOOLTIP_WIDTH = 280;

/**
 * The values under the cursor of MeasurementSamplesCompareChart - always at
 * the same place (a corner of the plot, `style`) instead of following the
 * cursor. The row of the highlighted line (`activeKey`) is bold.
 */
const MeasurementCompareTooltip = ({
  tooltip,
  activeKey,
  style,
  ref,
  testId = 'measurement-compare-tooltip',
}: {
  tooltip: CompareTooltipData;
  activeKey: string | null;
  style: CSSProperties;
  ref?: Ref<HTMLDivElement>;
  /** data-testid of the tooltip; its rows' names / values are "<testId>-name" / "-value" (key: the trace uid). */
  testId?: string;
}) => (
  <div
    ref={ref}
    className="measurement-compare-tooltip position-absolute bg-white border rounded shadow-sm small px-2 py-1"
    // Fixed width: growing and shrinking with the values, it would flicker
    // while the cursor moves.
    style={{ width: TOOLTIP_WIDTH, ...style }}
    data-testid={testId}
  >
    <div className="fw-semibold text-truncate" data-testid={childTestId(testId, 'title')}>
      {tooltip.title}
    </div>
    {tooltip.subtitle && (
      <div
        className="measurement-compare-tooltip-subtitle text-muted text-truncate"
        data-testid={childTestId(testId, 'subtitle')}
      >
        {tooltip.subtitle}
      </div>
    )}
    <div className="measurement-compare-tooltip-rows mt-1">
      {tooltip.rows.map((row) => {
        const active = row.key === activeKey ? 'fw-semibold' : undefined;
        return (
          <Fragment key={row.key}>
            <span
              className={
                row.band
                  ? 'measurement-compare-tooltip-swatch measurement-compare-tooltip-swatch--band'
                  : 'measurement-compare-tooltip-swatch'
              }
              style={swatchStyle(row)}
            />
            <span
              className={`text-truncate ${active ?? ''}`}
              title={row.name}
              data-testid={childTestId(testId, 'name')}
              data-test-key={row.key}
            >
              {row.name}
            </span>
            <span
              className={`measurement-compare-tooltip-value ${active ?? ''}`}
              data-testid={childTestId(testId, 'value')}
              data-test-key={row.key}
            >
              {row.value}
            </span>
          </Fragment>
        );
      })}
    </div>
  </div>
);

export default MeasurementCompareTooltip;
