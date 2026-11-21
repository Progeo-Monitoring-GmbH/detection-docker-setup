import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import SearchableDataTable, {
  progeoTableStyles,
  type SearchableColumn,
} from '../components/ui/kit/SearchableDataTable';
import StateBadge from '../components/ui/kit/StateBadge';
import type { AlarmHistoryEntry } from './computedSuspicion';
import { formatDate } from './dateFormat';
import { repeatedTestId } from '../testIds';
import './AlarmHistoryTable.css';

const ALARM_HISTORY_PAGE_SIZE = 25;

type AlarmHistoryTableProps = {
  entries: AlarmHistoryEntry[];
  /** A computed point's history: a sensor column (entries carry sensor_id). */
  sensorLabel?: (sensorId: number) => string;
  /** data-testid of the table; each row's date cell is "<rowTestId>" keyed by the entry id. */
  testId: string;
  rowTestId: string;
};

/**
 * The "Alarm-Verlauf" of a Verdachtsstelle or a computed point: its
 * over-threshold readings, newest first, 25 per page - sortable by every
 * column, searchable (a computed point's history spans several sensors).
 */
const AlarmHistoryTable = ({
  entries,
  sensorLabel,
  testId,
  rowTestId,
}: AlarmHistoryTableProps) => {
  const { t } = useTranslation();
  const columns = useMemo<SearchableColumn<AlarmHistoryEntry>[]>(
    () => [
      {
        id: 'date',
        name: t('status_col_date'),
        selector: (entry) => entry.triggered_at ?? '',
        sortable: true,
        grow: 1.4,
        cell: (entry) => (
          <span
            className="alarm-history-date"
            {...repeatedTestId(rowTestId, entry.id)}
          >
            {formatDate(entry.triggered_at)}
          </span>
        ),
        searchText: (entry) => formatDate(entry.triggered_at),
      },
      ...(sensorLabel
        ? [
            {
              id: 'sensor',
              name: t('status_col_sensor'),
              selector: (entry: AlarmHistoryEntry) => entry.sensor_id ?? -1,
              sortable: true,
              cell: (entry: AlarmHistoryEntry) =>
                entry.sensor_id != null ? sensorLabel(entry.sensor_id) : '–',
              searchText: (entry: AlarmHistoryEntry) =>
                entry.sensor_id != null ? sensorLabel(entry.sensor_id) : '',
            },
          ]
        : []),
      {
        id: 'state',
        name: t('status_col_state'),
        selector: (entry) => entry.state,
        sortable: true,
        cell: (entry) => (
          <StateBadge state={entry.state} label={t(`ui_${entry.state}`)} />
        ),
        searchText: (entry) => t(`ui_${entry.state}`),
      },
      {
        id: 'value',
        name: t('status_col_value'),
        selector: (entry) => entry.value ?? -1,
        sortable: true,
        right: true,
        cell: (entry) => (
          <span className="alarm-history-value">
            {entry.value != null ? `${Math.round(entry.value)} mV` : '–'}
          </span>
        ),
      },
    ],
    [rowTestId, sensorLabel, t],
  );

  return (
    <div className="alarm-history">
      <SearchableDataTable
        columns={columns}
        data={entries}
        keyField="id"
        defaultSortFieldId="date"
        defaultSortAsc={false}
        pagination
        paginationPerPage={ALARM_HISTORY_PAGE_SIZE}
        paginationRowsPerPageOptions={[ALARM_HISTORY_PAGE_SIZE]}
        customStyles={progeoTableStyles}
        dense
        noDataComponent={
          <div className="small text-muted py-2">
            {t('status_alarm_history_empty')}
          </div>
        }
        mobileColumns={['date', 'value']}
        testId={testId}
      />
    </div>
  );
};

export default AlarmHistoryTable;
