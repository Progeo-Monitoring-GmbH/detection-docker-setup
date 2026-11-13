import './kit.css';

export type StatTileProps = {
  label: string;
  value: string;
  unit?: string;
  note?: string;
  valueColor?: string;
  /** data-testid of the tile (its value: "<testId>-value"). */
  testId?: string;
};

/** One KPI cell (label / value+unit / note) inside a KpiStrip. */
const StatTile = ({ label, value, unit, note, valueColor, testId }: StatTileProps) => (
  <div className="progeo-stat" data-testid={testId}>
    <div className="progeo-stat-label">{label}</div>
    <div className="progeo-stat-value">
      <span
        className="progeo-stat-number"
        style={valueColor ? { color: valueColor } : undefined}
        data-testid={testId ? `${testId}-value` : undefined}
      >
        {value}
      </span>
      {unit && <span className="progeo-stat-unit">{unit}</span>}
    </div>
    {note && <div className="progeo-stat-note">{note}</div>}
  </div>
);

export default StatTile;
