import { type CSSProperties, Fragment, type Ref } from 'react';

export type CompareTooltipRow = {
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

const swatchStyle = (row: CompareTooltipRow): CSSProperties =>
  row.band
    ? { width: 12, height: 10, background: row.color, border: `1px solid ${row.color}`, borderRadius: 2 }
    : { width: 14, height: 3, background: row.color, borderRadius: 2 };

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
}: {
  tooltip: CompareTooltipData;
  activeKey: string | null;
  style: CSSProperties;
  ref?: Ref<HTMLDivElement>;
}) => (
  <div
    ref={ref}
    className="position-absolute bg-white border rounded shadow-sm small px-2 py-1"
    // Fixed width: growing and shrinking with the values, it would flicker
    // while the cursor moves.
    style={{ pointerEvents: 'none', zIndex: 2, width: TOOLTIP_WIDTH, opacity: 0.95, ...style }}
  >
    <div className="fw-semibold text-truncate">{tooltip.title}</div>
    {tooltip.subtitle && (
      <div className="text-muted text-truncate" style={{ fontSize: 11 }}>
        {tooltip.subtitle}
      </div>
    )}
    <div
      className="mt-1"
      style={{
        display: 'grid',
        gridTemplateColumns: 'auto minmax(0, 1fr) auto',
        alignItems: 'center',
        columnGap: 8,
        rowGap: 2,
      }}
    >
      {tooltip.rows.map((row) => {
        const active = row.key === activeKey ? 'fw-semibold' : undefined;
        return (
          <Fragment key={row.key}>
            <span style={swatchStyle(row)} />
            <span className={`text-truncate ${active ?? ''}`} title={row.name}>
              {row.name}
            </span>
            <span
              className={active}
              style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}
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
