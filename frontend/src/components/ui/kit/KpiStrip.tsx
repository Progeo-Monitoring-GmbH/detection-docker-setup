import StatTile, { type StatTileProps } from './StatTile';
import './kit.css';

type KpiStripProps = {
  tiles: StatTileProps[];
  /** data-testid of the strip. */
  testId?: string;
};

/** The grid of KPI tiles at the top of the Status screen. */
const KpiStrip = ({ tiles, testId }: KpiStripProps) => (
  <div className="progeo-kpi-strip" data-testid={testId}>
    {tiles.map((tile) => (
      <div key={tile.label}>
        <StatTile {...tile} />
      </div>
    ))}
  </div>
);

export default KpiStrip;
