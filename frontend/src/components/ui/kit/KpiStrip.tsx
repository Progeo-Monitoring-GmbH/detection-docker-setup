import StatTile, { type StatTileProps } from './StatTile';
import './kit.css';

type KpiStripProps = {
  tiles: StatTileProps[];
};

/** The grid of KPI tiles at the top of the Status screen. */
const KpiStrip = ({ tiles }: KpiStripProps) => (
  <div className="progeo-kpi-strip">
    {tiles.map((tile) => (
      <div key={tile.label}>
        <StatTile {...tile} />
      </div>
    ))}
  </div>
);

export default KpiStrip;
