import { useEffect, useMemo, useState } from 'react';
import { Spinner } from 'react-bootstrap';
import DataTable, { type TableColumn } from 'react-data-table-component';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import ThresholdTrendChart, { TREND_COLORS } from '../components/device/ThresholdTrendChart';
import { PercentCell } from '../components/device/SensorChangesPanel';
import PanelCard from '../components/ui/kit/PanelCard';
import PillButton from '../components/ui/kit/PillButton';
import PlotHelp from '../components/ui/PlotHelp';
import { progeoTableStyles } from '../components/ui/kit/SearchableDataTable';
import { staffFlags } from './access';
import './ZeitreihePanel.css';
import {
  ACTIVE_RANGE,
  byPeak,
  byRange,
  defaultZeitreiheIds,
  SILENT_RANGE,
  toggledId,
  type ZeitreiheSensor,
} from './zeitreiheSensors';

const MUTED = '#8B8383';
/** Rows per page of each table. */
const TABLE_PAGE = 8;
const NO_HIDDEN = new Set<string>();

type TableKind = 'triggered' | 'active' | 'silent';

/** Which sensors each table lists - and in which order. */
const TABLES: { kind: TableKind; rows: (sensors: ZeitreiheSensor[]) => ZeitreiheSensor[] }[] = [
  { kind: 'triggered', rows: (sensors) => sensors.filter((sensor) => sensor.triggered).sort(byPeak) },
  { kind: 'active', rows: (sensors) => sensors.filter((sensor) => sensor.active).sort(byRange) },
  { kind: 'silent', rows: (sensors) => sensors.filter((sensor) => sensor.silent).sort((a, b) => byRange(b, a)) },
];

const formatValue = (value: number) => String(Math.round(value));

/** A plotted sensor: its line colour; a filled ring otherwise. */
const SensorSwatch = ({ color }: { color: string | null }) => (
  <span
    aria-hidden="true"
    className={`zeitreihe-swatch${color ? '' : ' zeitreihe-swatch--empty'}`}
    style={color ? { background: color } : undefined}
  />
);

/**
 * "Messwerte im Zeitverlauf": a few sensors at a time instead of all of them
 * - by default the triggered ones, then the most active
 * (defaultZeitreiheIds). Three linked tables list the sensors that are
 * triggered (a value above the threshold), active (large span) or silent
 * (hardly any change) - a sensor can be in several. A row click adds the
 * sensor to the plot (or removes it), hovering a row, a line or a legend
 * entry highlights it. "Nur ausgelöste Sensoren" plots exactly the
 * triggered ones; "Zurücksetzen" goes back to the default.
 */
const ZeitreihePanel = ({ loading, sensors }: { loading: boolean; sensors: ZeitreiheSensor[] }) => {
  const { t } = useTranslation();
  const auth = useAuth();
  // "Aktive" and "Ruhige Sensoren" are an analysis aid for ProGeo staff;
  // customers get the triggered sensors only.
  const tables = staffFlags(auth?.user).isStaffOrSuperuser
    ? TABLES
    : TABLES.filter(({ kind }) => kind === 'triggered');
  // null: the default selection (it follows the data, e.g. another period).
  const [picked, setPicked] = useState<string[] | null>(null);
  const [onlyTriggered, setOnlyTriggered] = useState(false);
  const [highlighted, setHighlighted] = useState<string | null>(null);

  const byId = useMemo(() => new Map(sensors.map((sensor) => [sensor.id, sensor])), [sensors]);
  const triggeredIds = useMemo(
    () => sensors.filter((sensor) => sensor.triggered).sort(byPeak).map((sensor) => sensor.id),
    [sensors],
  );
  const defaultIds = useMemo(() => defaultZeitreiheIds(sensors), [sensors]);

  // A new period can drop sensors - keep the choice of the others.
  useEffect(() => {
    setPicked((current) => current && current.filter((id) => byId.has(id)));
    setHighlighted((current) => (current && byId.has(current) ? current : null));
  }, [byId]);

  const shownIds = onlyTriggered ? triggeredIds : (picked ?? defaultIds);
  const colorOf = (id: string) => {
    const index = shownIds.indexOf(id);
    return index < 0 ? null : TREND_COLORS[index % TREND_COLORS.length];
  };
  const customized = onlyTriggered || picked != null;

  const toggleSensor = (id: string) => {
    setPicked(toggledId(shownIds, id));
    setOnlyTriggered(false);
  };
  const reset = () => {
    setPicked(null);
    setOnlyTriggered(false);
  };

  // A hovered table row of a sensor that isn't plotted: drawn as a preview.
  const previewId = highlighted && !shownIds.includes(highlighted) ? highlighted : null;
  const series = [
    ...shownIds.flatMap((id) => {
      const sensor = byId.get(id);
      return sensor ? [{ ...sensor, color: colorOf(id) ?? undefined }] : [];
    }),
    ...(previewId && byId.get(previewId)
      ? [{ ...byId.get(previewId)!, color: MUTED, preview: true }]
      : []),
  ];

  const columns = useMemo<TableColumn<ZeitreiheSensor>[]>(
    () => [
      {
        id: 'sensor',
        name: t('status_zeitreihe_col_sensor'),
        selector: (sensor) => sensor.sensorId,
        sortable: true,
        grow: 2,
        cell: (sensor) => (
          <span data-tag="allowRowEvents" className="zeitreihe-sensor-cell">
            <SensorSwatch color={colorOf(sensor.id)} />
            <span data-tag="allowRowEvents" className="zeitreihe-sensor-label">
              {sensor.label}
            </span>
          </span>
        ),
      },
      {
        id: 'max',
        name: t('status_zeitreihe_col_max'),
        selector: (sensor) => sensor.max,
        sortable: true,
        right: true,
        cell: (sensor) => (
          <span
            data-tag="allowRowEvents"
            title={sensor.threshold != null ? t('status_zeitreihe_threshold_of', { value: sensor.threshold }) : undefined}
            className={`zeitreihe-number${sensor.triggered ? ' zeitreihe-number--over' : ''}`}
          >
            {formatValue(sensor.max)}
          </span>
        ),
      },
      {
        id: 'range',
        name: t('status_zeitreihe_col_range'),
        selector: (sensor) => sensor.range,
        sortable: true,
        right: true,
        cell: (sensor) => (
          <span data-tag="allowRowEvents" className="zeitreihe-number">
            {formatValue(sensor.range)}
          </span>
        ),
      },
      {
        id: 'trend',
        name: t('status_zeitreihe_col_trend'),
        selector: (sensor) => sensor.trend ?? 0,
        sortable: true,
        right: true,
        cell: (sensor) => <PercentCell percent={sensor.trend} change={sensor.max - sensor.min} />,
      },
    ],
    // colorOf follows shownIds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, shownIds.join(',')],
  );

  const tableHint: Record<TableKind, string> = {
    triggered: t('status_zeitreihe_triggered_hint'),
    active: t('status_zeitreihe_active_hint', { percent: ACTIVE_RANGE * 100 }),
    silent: t('status_zeitreihe_silent_hint', { percent: SILENT_RANGE * 100 }),
  };

  return (
    <PanelCard
      testId="zeitreihe"
      title={t('status_zeitreihe_title')}
      actions={
        <div className="d-flex align-items-center gap-2 flex-wrap">
          {!loading && sensors.length > 0 && (
            <>
              <span className="zeitreihe-muted" data-testid="zeitreihe-shown">
                {t('status_zeitreihe_shown', { shown: shownIds.length, total: sensors.length })}
              </span>
              <PillButton
                testId="zeitreihe-only-triggered"
                variant={onlyTriggered ? 'accent' : 'ghost'}
                label={t('status_zeitreihe_only_triggered', { count: triggeredIds.length })}
                disabled={triggeredIds.length === 0}
                onClick={() => (onlyTriggered ? reset() : setOnlyTriggered(true))}
              />
              {customized && (
                <PillButton testId="zeitreihe-reset" variant="ghost" label={t('status_zeitreihe_reset')} onClick={reset} />
              )}
            </>
          )}
          <PlotHelp topic="status_zeitreihe" testId="zeitreihe-help" />
        </div>
      }
    >
      {loading ? (
        <div className="d-flex justify-content-center py-5 text-muted" data-testid="zeitreihe-loading">
          <Spinner animation="border" className="me-2" /> {t('ui_loading')}
        </div>
      ) : (
        <div className="d-flex flex-column gap-3" data-testid="zeitreihe-content">
          <ThresholdTrendChart
            series={series}
            hiddenSeries={NO_HIDDEN}
            onToggleSeries={toggleSensor}
            emptyLabel={
              sensors.length ? t('status_zeitreihe_nothing_shown') : t('status_zeitreihe_empty')
            }
            meanOfLabel={(count) => t('status_zeitreihe_mean_of', { count })}
            thresholdLabel={t('status_zeitreihe_threshold_legend')}
            highlightedId={highlighted}
            onHighlight={setHighlighted}
          />

          {sensors.length > 0 && (
            <div
              className="zeitreihe-tables"
              data-testid="zeitreihe-tables"
              onMouseLeave={() => setHighlighted(null)}
            >
              {tables.map(({ kind, rows }) => {
                const data = rows(sensors);
                return (
                  <div key={kind} data-testid={`zeitreihe-${kind}`} className="zeitreihe-table">
                    <div className="d-flex align-items-baseline gap-2">
                      <span className="zeitreihe-table-title">
                        {t(`status_zeitreihe_${kind}_title`)}
                      </span>
                      <span className="zeitreihe-muted" data-testid={`zeitreihe-${kind}-count`}>
                        {data.length}
                      </span>
                    </div>
                    <div className="zeitreihe-hint zeitreihe-hint--table">{tableHint[kind]}</div>
                    {data.length === 0 ? (
                      <div className="zeitreihe-table-empty" data-testid={`zeitreihe-${kind}-empty`}>
                        {t('status_zeitreihe_table_empty')}
                      </div>
                    ) : (
                      <DataTable
                        columns={columns}
                        data={data}
                        keyField="id"
                        customStyles={progeoTableStyles}
                        dense
                        highlightOnHover
                        pointerOnHover
                        pagination={data.length > TABLE_PAGE}
                        paginationPerPage={TABLE_PAGE}
                        paginationComponentOptions={{ noRowsPerPage: true }}
                        conditionalRowStyles={[
                          {
                            when: (sensor) => sensor.id === highlighted,
                            style: { backgroundColor: 'rgba(11, 54, 89, .08)' },
                          },
                        ]}
                        onRowClicked={(sensor) => toggleSensor(sensor.id)}
                        onRowMouseEnter={(sensor) => setHighlighted(sensor.id)}
                        onRowMouseLeave={() => setHighlighted(null)}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {sensors.length > 0 && (
            <div className="zeitreihe-hint">{t('status_zeitreihe_table_click')}</div>
          )}
        </div>
      )}
    </PanelCard>
  );
};

export default ZeitreihePanel;
