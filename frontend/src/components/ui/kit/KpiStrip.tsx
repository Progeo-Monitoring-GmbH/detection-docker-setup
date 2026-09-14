import StatTile, { type StatTileProps } from './StatTile';

type KpiStripProps = {
  tiles: StatTileProps[];
};

/** The grid of KPI tiles at the top of the Status screen. */
const KpiStrip = ({ tiles }: KpiStripProps) => {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
        background: 'var(--progeo-panel-bg)',
        borderRadius: 'var(--progeo-radius-panel)',
        boxShadow: 'var(--progeo-shadow-panel)',
        overflow: 'hidden',
      }}
    >
      {tiles.map((tile, index) => (
        <div
          key={tile.label}
          style={{
            borderRight: index < tiles.length - 1 ? '1px solid var(--progeo-track)' : 'none',
          }}
        >
          <StatTile {...tile} />
        </div>
      ))}
    </div>
  );
};

export default KpiStrip;
