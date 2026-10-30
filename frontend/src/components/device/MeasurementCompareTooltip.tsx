import { type CSSProperties, Fragment } from 'react';

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

/**
 * The values under the cursor of MeasurementSamplesCompareChart - always at
 * the same place (a corner of the plot, `style`) instead of following the
 * cursor. The row of the highlighted line (`activeKey`) is bold.
 */
const MeasurementCompareTooltip = ({
  tooltip,
  activeKey,
  style,
}: {
  tooltip: CompareTooltipData;
  activeKey: string | null;
  style: CSSProperties;
}) => (
  <div
    className="position-absolute bg-white border rounded shadow-sm small px-2 py-1"
    style={{ pointerEvents: 'none', zIndex: 2, minWidth: 190, opacity: 0.95, ...style }}
  >
    <div className="fw-semibold">{tooltip.title}</div>
    {tooltip.subtitle && (
      <div className="text-muted" style={{ fontSize: 11 }}>
        {tooltip.subtitle}
      </div>
    )}
    <div
      className="mt-1"
      style={{
        display: 'grid',
        gridTemplateColumns: 'auto 1fr auto',
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
            <span className={active}>{row.name}</span>
            <span className={active} style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
              {row.value}
            </span>
          </Fragment>
        );
      })}
    </div>
  </div>
);

export default MeasurementCompareTooltip;
