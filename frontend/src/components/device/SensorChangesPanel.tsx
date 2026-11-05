import { useMemo } from 'react';
import DataTable, { type TableColumn } from 'react-data-table-component';
import { CheckLg } from 'react-bootstrap-icons';
import { useTranslation } from 'react-i18next';
import type { SensorChange } from './measurementBands';

/** Rows per page of the table. */
export const CHANGES_PAGE = 10;

const UP_COLOR = '#3F7A1C';
const DOWN_COLOR = '#C44D26';
const MUTED = '#8B8383';

type SensorChangesPanelProps = {
  /** Biggest first (sensorChanges) - the order until a column is sorted. */
  changes: SensorChange[];
  /** Colours of the change lines in the plot. */
  wpColor: string;
  epColor: string;
  /** Sensors (index) shown in the measurements' second plot - marked. */
  selectedSensors?: number[];
  /** A click on a sensor: show it in (or remove it from) the second plot. */
  onSensorSelect?: (sensor: number) => void;
  /** The hovered sensor (null when left) - marked in the plot. */
  onSensorHover?: (sensor: number | null) => void;
};

/** Change in percent of the old value; null when there was none (0). */
export const percentChange = (then: number, now: number): number | null =>
  then === 0 ? null : ((now - then) / Math.abs(then)) * 100;

const formatPercent = (value: number) =>
  `${value > 0 ? '+' : value < 0 ? '−' : '±'}${Math.abs(value).toFixed(1)} %`;

/** Ascending, a missing percentage after every number (also when DataTable reverses it). */
const byPercent =
  (pick: (change: SensorChange) => number | null) => (a: SensorChange, b: SensorChange) => {
    const left = pick(a);
    const right = pick(b);
    if (left == null || right == null) {
      return left == null && right == null ? 0 : left == null ? 1 : -1;
    }
    return left - right;
  };

const wpPercent = (change: SensorChange) => percentChange(change.wpThen, change.wpNow);
const epPercent = (change: SensorChange) => percentChange(change.epThen, change.epNow);

/** The percentage, plus green and minus red; without an old value the absolute change as a hint. */
export const PercentCell = ({ percent, change }: { percent: number | null; change: number }) =>
  percent == null ? (
    <span style={{ color: MUTED }} title={`${change > 0 ? '+' : ''}${change.toFixed(2)}`}>
      –
    </span>
  ) : (
    <span
      style={{
        color: percent > 0 ? UP_COLOR : percent < 0 ? DOWN_COLOR : MUTED,
        fontVariantNumeric: 'tabular-nums',
        fontWeight: 600,
      }}
    >
      {formatPercent(percent)}
    </span>
  );

const Swatch = ({ color }: { color: string }) => (
  <span
    aria-hidden="true"
    style={{
      display: 'inline-block',
      width: 10,
      height: 3,
      borderRadius: 2,
      background: color,
      marginRight: 4,
      verticalAlign: 'middle',
    }}
  />
);

const tableStyles = {
  table: { style: { backgroundColor: 'transparent' } },
  headRow: { style: { minHeight: '32px', backgroundColor: 'transparent' } },
  headCells: { style: { fontSize: '11.5px', color: MUTED, fontWeight: 500 } },
  rows: { style: { minHeight: '32px', fontSize: '12.5px', backgroundColor: 'transparent' } },
  pagination: { style: { backgroundColor: 'transparent', minHeight: '40px', fontSize: '12px' } },
};

/**
 * The comparison's biggest changes: per sensor the change of WP and EP since
 * then in percent of the old value, sortable, CHANGES_PAGE per page. A click
 * shows the sensor in the measurements' second plot.
 */
const SensorChangesPanel = ({
  changes,
  wpColor,
  epColor,
  selectedSensors = [],
  onSensorSelect,
  onSensorHover,
}: SensorChangesPanelProps) => {
  const { t } = useTranslation();

  const columns = useMemo<TableColumn<SensorChange>[]>(
    () => [
      {
        id: 'sensor',
        name: t('measurement_compare_pair_label'),
        selector: (change) => change.sensor,
        sortable: true,
        cell: (change) => (
          <span>
            {t('measurement_compare_pair_label')} {change.sensor + 1}
            {selectedSensors.includes(change.sensor) && <CheckLg className="ms-1 text-primary" size={12} />}
          </span>
        ),
      },
      {
        id: 'wp',
        name: (
          <span>
            <Swatch color={wpColor} />
            {t('analyse_compare_col_wp')}
          </span>
        ),
        selector: (change) => wpPercent(change) ?? 0,
        sortable: true,
        sortFunction: byPercent(wpPercent),
        cell: (change) => <PercentCell percent={wpPercent(change)} change={change.wpChange} />,
        right: true,
      },
      {
        id: 'ep',
        name: (
          <span>
            <Swatch color={epColor} />
            {t('analyse_compare_col_ep')}
          </span>
        ),
        selector: (change) => epPercent(change) ?? 0,
        sortable: true,
        sortFunction: byPercent(epPercent),
        cell: (change) => <PercentCell percent={epPercent(change)} change={change.epChange} />,
        right: true,
      },
    ],
    [t, wpColor, epColor, selectedSensors],
  );

  return (
    <div data-testid="sensor-changes" style={{ fontSize: 12.5 }}>
      <div className="fw-semibold mb-1" style={{ color: 'var(--progeo-blue)' }}>
        {t('analyse_compare_changes_title')}
      </div>
      <div className="text-muted mb-2" style={{ fontSize: 11.5 }}>
        {t('analyse_compare_changes_hint')}
      </div>
      {changes.length === 0 ? (
        <div className="text-muted">{t('analyse_compare_changes_empty')}</div>
      ) : (
        <DataTable
          columns={columns}
          data={changes}
          keyField="sensor"
          customStyles={tableStyles}
          dense
          highlightOnHover
          pointerOnHover={Boolean(onSensorSelect)}
          pagination={changes.length > CHANGES_PAGE}
          paginationPerPage={CHANGES_PAGE}
          paginationRowsPerPageOptions={[CHANGES_PAGE, 25, 50, 100]}
          conditionalRowStyles={[
            {
              when: (change) => selectedSensors.includes(change.sensor),
              style: { backgroundColor: 'rgba(11, 54, 89, .06)' },
            },
          ]}
          onRowClicked={(change) => onSensorSelect?.(change.sensor)}
          onRowMouseEnter={(change) => onSensorHover?.(change.sensor)}
          onRowMouseLeave={() => onSensorHover?.(null)}
        />
      )}
    </div>
  );
};

export default SensorChangesPanel;
