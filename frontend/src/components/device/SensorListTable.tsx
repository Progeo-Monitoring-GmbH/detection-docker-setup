import { useTranslation } from 'react-i18next';

export type SensorListRow = {
  key: string;
  label: string;
  value: number | null;
  threshold: number | null;
};

type SensorListTableProps = {
  rows: SensorListRow[];
};

/**
 * Plain "one row per sensor" fallback (Status tab): used when a location has
 * a Lageplan but no positioned ProgeoMeasurePoint yet (nothing to draw a
 * heatmap/zone overlay on top of), and additionally alongside the heatmap
 * for smartex locations.
 */
const SensorListTable = ({ rows }: SensorListTableProps) => {
  const { t } = useTranslation();

  if (rows.length === 0) {
    return (
      <div style={{ color: '#8B8383', fontSize: 13, padding: '10px 2px' }}>
        {t('status_sensor_table_empty')}
      </div>
    );
  }

  return (
    <div style={{ background: 'var(--progeo-surface)', borderRadius: 11, overflow: 'hidden' }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1.4fr 1fr 1fr',
          padding: '9px 12px',
          fontSize: 10.5,
          letterSpacing: '.06em',
          textTransform: 'uppercase',
          color: '#8B8383',
          fontWeight: 500,
        }}
      >
        <span>{t('status_sensor_table_sensor')}</span>
        <span>{t('status_sensor_table_value')}</span>
        <span>{t('status_sensor_table_threshold')}</span>
      </div>
      {rows.map((row) => {
        const isOver = row.value != null && row.threshold != null && row.value > row.threshold;
        return (
          <div
            key={row.key}
            style={{
              display: 'grid',
              gridTemplateColumns: '1.4fr 1fr 1fr',
              padding: '9px 12px',
              fontSize: 12.5,
              borderTop: '1px solid var(--progeo-track-soft)',
            }}
          >
            <span style={{ fontWeight: 600 }}>{row.label}</span>
            <span style={{ fontWeight: 600, color: isOver ? 'var(--progeo-orange)' : undefined }}>
              {row.value != null ? `${Math.round(row.value)} mV` : '–'}
            </span>
            <span style={{ color: '#8B8383' }}>
              {row.threshold != null ? `${Math.round(row.threshold)} mV` : '–'}
            </span>
          </div>
        );
      })}
    </div>
  );
};

export default SensorListTable;
