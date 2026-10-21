import { useMemo } from 'react';
import DataTable, { type TableColumn } from 'react-data-table-component';
import { useTranslation } from 'react-i18next';

export type SensorListRow = {
  key: string;
  label: string;
  /** Value at the shown timestamp (the heatmap slider), else the newest. */
  value: number | null;
  /** Highest value of the loaded measurements. */
  max: number | null;
  threshold: number | null;
};

type SensorListTableProps = {
  rows: SensorListRow[];
};

const OVER_COLOR = '#dc2626';

const formatMv = (value: number | null) => (value != null ? `${Math.round(value)} mV` : '–');

const isOver = (value: number | null, threshold: number | null) =>
  value != null && threshold != null && value > threshold;

/** Sorts numbers ascending, missing values below every number (DataTable reverses it for descending). */
const byNumber = (pick: (row: SensorListRow) => number | null) => (a: SensorListRow, b: SensorListRow) => {
  const left = pick(a);
  const right = pick(b);
  if (left == null || right == null) {
    return left == null && right == null ? 0 : left == null ? 1 : -1;
  }
  return left - right;
};

const tableStyles = {
  table: { style: { backgroundColor: 'transparent' } },
  headRow: {
    style: {
      minHeight: '36px',
      backgroundColor: 'transparent',
      borderBottomColor: 'var(--progeo-track-soft)',
    },
  },
  headCells: {
    style: {
      fontSize: '10.5px',
      letterSpacing: '.06em',
      textTransform: 'uppercase' as const,
      color: '#8B8383',
      fontWeight: 500,
    },
  },
  rows: {
    style: {
      minHeight: '36px',
      fontSize: '12.5px',
      backgroundColor: 'transparent',
      '&:not(:last-of-type)': { borderBottomColor: 'var(--progeo-track-soft)' },
    },
  },
};

/**
 * "One row per sensor" (Status tab): next to the smartex heatmap - with the
 * values of the timestamp its slider shows - and as the fallback when a
 * location has no positioned measure points. Sortable by every column.
 */
const SensorListTable = ({ rows }: SensorListTableProps) => {
  const { t } = useTranslation();

  const columns = useMemo<TableColumn<SensorListRow>[]>(
    () => [
      {
        id: 'sensor',
        name: t('status_sensor_table_sensor'),
        selector: (row) => row.label,
        sortable: true,
        // Sensor numbers in their natural order ("2" before "10").
        sortFunction: (a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }),
        cell: (row) => <span style={{ fontWeight: 600 }}>{row.label}</span>,
        grow: 1.4,
      },
      {
        id: 'value',
        name: t('status_sensor_table_value'),
        selector: (row) => row.value ?? -Infinity,
        sortable: true,
        sortFunction: byNumber((row) => row.value),
        cell: (row) => (
          <span style={{ fontWeight: 600, color: isOver(row.value, row.threshold) ? OVER_COLOR : undefined }}>
            {formatMv(row.value)}
          </span>
        ),
        right: true,
      },
      {
        id: 'max',
        name: t('status_sensor_table_max'),
        selector: (row) => row.max ?? -Infinity,
        sortable: true,
        sortFunction: byNumber((row) => row.max),
        cell: (row) => (
          <span style={{ color: isOver(row.max, row.threshold) ? OVER_COLOR : undefined }}>
            {formatMv(row.max)}
          </span>
        ),
        right: true,
      },
      {
        id: 'threshold',
        name: t('status_sensor_table_threshold'),
        selector: (row) => row.threshold ?? -Infinity,
        sortable: true,
        sortFunction: byNumber((row) => row.threshold),
        cell: (row) => <span style={{ color: '#8B8383' }}>{formatMv(row.threshold)}</span>,
        right: true,
      },
    ],
    [t],
  );

  if (rows.length === 0) {
    return (
      <div style={{ color: '#8B8383', fontSize: 13, padding: '10px 2px' }}>
        {t('status_sensor_table_empty')}
      </div>
    );
  }

  return (
    <div style={{ background: 'var(--progeo-surface)', borderRadius: 11, overflow: 'hidden' }}>
      <DataTable
        columns={columns}
        data={rows}
        keyField="key"
        customStyles={tableStyles}
        defaultSortFieldId="sensor"
        highlightOnHover
        dense
      />
    </div>
  );
};

export default SensorListTable;
