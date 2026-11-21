import { useMemo } from 'react';
import DataTable, { type TableColumn } from 'react-data-table-component';
import { useTranslation } from 'react-i18next';
import { childTestId, repeatedTestId } from '../../testIds';
import { progeoTableStyles } from '../ui/kit/SearchableDataTable';
import './SensorListTable.css';

export type SensorListRow = {
  key: string;
  label: string;
  /** Value at the shown timestamp (the heatmap slider), else the newest. */
  value: number | null;
  /** Highest value of the loaded measurements. */
  max: number | null;
  threshold: number | null;
  /** Switched off: gray, never red (it raises no alarm). */
  disabled?: boolean;
};

type SensorListTableProps = {
  rows: SensorListRow[];
  /** data-testid of the table; each row's sensor cell is "<testId>-row" (key: the row key), its value "<testId>-value". */
  testId?: string;
};

const formatMv = (value: number | null) => (value != null ? `${Math.round(value)} mV` : '–');

/** Above the threshold - never for a disabled sensor. */
const isOver = (row: SensorListRow, value: number | null) =>
  !row.disabled && value != null && row.threshold != null && value > row.threshold;

/** The class of a reading: gray when disabled, red when over. */
const readingClass = (row: SensorListRow, value: number | null, base = '') =>
  [base, row.disabled ? 'sensor-list--disabled' : isOver(row, value) ? 'sensor-list--over' : '']
    .filter(Boolean)
    .join(' ') || undefined;

/** Sorts numbers ascending, missing values below every number (DataTable reverses it for descending). */
const byNumber = (pick: (row: SensorListRow) => number | null) => (a: SensorListRow, b: SensorListRow) => {
  const left = pick(a);
  const right = pick(b);
  if (left == null || right == null) {
    return left == null && right == null ? 0 : left == null ? 1 : -1;
  }
  return left - right;
};

/**
 * "One row per sensor" (Status tab): next to the smartex heatmap - with the
 * values of the timestamp its slider shows - and as the fallback when a
 * location has no positioned measure points. Sortable by every column.
 */
const SensorListTable = ({ rows, testId = 'sensor-list-table' }: SensorListTableProps) => {
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
        cell: (row) => (
          <span
            className={readingClass(row, null, 'sensor-list-strong')}
            title={row.disabled ? t('status_sensor_table_disabled_hint') : undefined}
            {...repeatedTestId(`${testId}-row`, row.key)}
          >
            {row.label}
          </span>
        ),
        grow: 1.4,
      },
      {
        id: 'value',
        name: t('status_sensor_table_value'),
        selector: (row) => row.value ?? -Infinity,
        sortable: true,
        sortFunction: byNumber((row) => row.value),
        cell: (row) => (
          <span
            className={readingClass(row, row.value, 'sensor-list-strong')}
            {...repeatedTestId(`${testId}-value`, row.key)}
          >
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
          <span className={readingClass(row, row.max)}>
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
        cell: (row) => (
          <span className="sensor-list-muted">
            {row.disabled ? t('status_sensor_table_disabled') : formatMv(row.threshold)}
          </span>
        ),
        right: true,
      },
    ],
    [t, testId],
  );

  if (rows.length === 0) {
    return (
      <div className="sensor-list-empty" data-testid={childTestId(testId, 'empty')}>
        {t('status_sensor_table_empty')}
      </div>
    );
  }

  return (
    <div className="sensor-list-table" data-testid={testId}>
      <DataTable
        columns={columns}
        data={rows}
        keyField="key"
        customStyles={progeoTableStyles}
        defaultSortFieldId="sensor"
        highlightOnHover
        dense
      />
    </div>
  );
};

export default SensorListTable;
