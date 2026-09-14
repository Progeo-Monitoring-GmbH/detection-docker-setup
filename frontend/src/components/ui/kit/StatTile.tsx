export type StatTileProps = {
  label: string;
  value: string;
  unit?: string;
  note?: string;
  valueColor?: string;
};

/** One KPI cell (label / value+unit / note) inside a KpiStrip. */
const StatTile = ({ label, value, unit, note, valueColor }: StatTileProps) => {
  return (
    <div
      style={{
        padding: '16px 20px',
        minWidth: 0,
      }}
    >
      <div style={{ fontSize: 13, color: '#6E6868', fontWeight: 400 }}>{label}</div>
      <div style={{ marginTop: 6 }}>
        <span
          style={{
            fontSize: 26,
            fontWeight: 500,
            letterSpacing: '-0.02em',
            color: valueColor || 'var(--progeo-blue)',
          }}
        >
          {value}
        </span>
        {unit && (
          <span style={{ fontSize: 12.5, color: '#8B8383', fontWeight: 400, marginLeft: 7 }}>
            {unit}
          </span>
        )}
      </div>
      {note && (
        <div style={{ marginTop: 5, fontSize: 12, color: '#8B8383', fontWeight: 400 }}>
          {note}
        </div>
      )}
    </div>
  );
};

export default StatTile;
