import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Spinner } from 'react-bootstrap';
import {
  ArrowClockwise,
  CheckCircleFill,
  ClockHistory,
  DashCircleFill,
  ExclamationTriangleFill,
  XCircleFill,
} from 'react-bootstrap-icons';
import Plot from 'react-plotly.js';
import { useTranslation } from 'react-i18next';
import { useSnackbar } from 'notistack';
import { useAuth } from '../../../hooks/CoreAuthProvider';
import axiosConfig from '../../axiosConfig';
import { showRequestError } from '../../components/ui/Snackbar.jsx';
import DonutChart from '../../components/ui/kit/DonutChart';
import KpiStrip from '../../components/ui/kit/KpiStrip';
import PanelCard from '../../components/ui/kit/PanelCard';
import PillButton from '../../components/ui/kit/PillButton';
import SearchableDataTable, { progeoTableStyles, type SearchableColumn } from '../../components/ui/kit/SearchableDataTable';
import SegmentedControl from '../../components/ui/kit/SegmentedControl';
import { PlotlyTouchScroll } from '../../components/ui/wheelZoom';
import { formatDate } from '../dateFormat';
import { baseLayout, formatBytes, plotConfig, STATUS_COLORS } from './chartTheme';
import './StaffInsights.css';

type Status = keyof typeof STATUS_COLORS;

/** One project database of GET /v1/database-usage/ (helper/database_usage.py). */
type DatabaseRow = {
  database: string;
  project: number | string | null;
  name: string | null;
  size_bytes: number | null;
  devices: number;
  measurements: number | null;
  stats_at: string | null;
  last_measurement_at: string | null;
  status: Status;
  error: string | null;
};

type Usage = {
  generated_at: string;
  stale_days: number;
  default: { database: string; size_bytes: number | null };
  totals: Record<Status, { databases: number; size_bytes: number }>;
  dead: number;
  databases: DatabaseRow[];
};

const STATUS_ORDER: Status[] = ['active', 'stale', 'no_measurements', 'no_devices', 'error'];
const DEAD: Status[] = ['no_measurements', 'no_devices'];
const STATUS_ICONS: Record<Status, ReactNode> = {
  active: <CheckCircleFill aria-hidden />,
  stale: <ClockHistory aria-hidden />,
  no_measurements: <DashCircleFill aria-hidden />,
  no_devices: <XCircleFill aria-hidden />,
  error: <ExclamationTriangleFill aria-hidden />,
};
const LARGEST = 15;

type Filter = 'all' | 'dead' | Status;

/** A status with its icon and label - its colour never stands alone. */
const StatusBadge = ({ status, label }: { status: Status; label: string }) => (
  <span className="staff-insights-status" data-status={status}>
    <span className="staff-insights-status-icon" style={{ color: STATUS_COLORS[status] }}>
      {STATUS_ICONS[status]}
    </span>
    {label}
  </span>
);

const projectLabel = (row: DatabaseRow) =>
  row.project == null ? row.database : typeof row.project === 'number' ? `#${row.project}` : String(row.project);

/**
 * Staff (sidebar: Database usage): how the project databases are used - by
 * status (pie: count or storage), the largest ones and every database in a
 * table. Dead databases have no devices or never received a measurement.
 * Data: GET /v1/database-usage/ (cached by the backend; Refresh recomputes).
 */
const DatabaseUsageView = () => {
  const { t } = useTranslation();
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const [usage, setUsage] = useState<Usage | null>(null);
  const [loading, setLoading] = useState(true);
  const [pieBy, setPieBy] = useState<'count' | 'size'>('count');
  const [filter, setFilter] = useState<Filter>('all');

  // Loading starts true; Refresh sets it itself (not here: called from the effect).
  const load = useCallback(
    (refresh: boolean) => {
      void axiosConfig.perform_get(
        auth,
        `/v1/database-usage/${refresh ? '?refresh=1' : ''}`,
        (response) => {
          setUsage((response?.data ?? null) as Usage | null);
          setLoading(false);
        },
        (error) => {
          setLoading(false);
          showRequestError(enqueueSnackbar, t('dbu_load_failed'), error);
        },
      );
    },
    [auth, enqueueSnackbar, t],
  );
  useEffect(() => load(false), [load]);

  const statusLabel = useCallback((status: Status) => t(`dbu_status_${status}`), [t]);
  const rows = useMemo(() => usage?.databases ?? [], [usage]);
  const shownRows = useMemo(
    () =>
      filter === 'all'
        ? rows
        : rows.filter((row) => (filter === 'dead' ? DEAD.includes(row.status) : row.status === filter)),
    [rows, filter],
  );
  const projectSize = rows.reduce((sum, row) => sum + (row.size_bytes ?? 0), 0);
  const deadSize = DEAD.reduce((sum, status) => sum + (usage?.totals[status]?.size_bytes ?? 0), 0);

  const kpis = [
    { label: t('dbu_kpi_databases'), value: usage ? String(rows.length) : '–' },
    {
      label: t('dbu_kpi_dead'),
      value: usage ? String(usage.dead) : '–',
      note: usage ? t('dbu_kpi_dead_note', { size: formatBytes(deadSize) }) : undefined,
      valueColor: usage?.dead ? STATUS_COLORS.no_devices : undefined,
    },
    {
      label: t('dbu_kpi_stale'),
      value: usage ? String(usage.totals.stale?.databases ?? 0) : '–',
      note: usage ? t('dbu_kpi_stale_note', { days: usage.stale_days }) : undefined,
    },
    { label: t('dbu_kpi_project_size'), value: usage ? formatBytes(projectSize) : '–' },
    {
      label: t('dbu_kpi_default_size'),
      value: usage ? formatBytes(usage.default.size_bytes) : '–',
      note: usage?.default.database,
    },
  ];

  const slices = STATUS_ORDER.map((status) => ({
    key: status,
    label: statusLabel(status),
    count: pieBy === 'count' ? (usage?.totals[status]?.databases ?? 0) : (usage?.totals[status]?.size_bytes ?? 0),
    color: STATUS_COLORS[status],
    icon: <span style={{ color: STATUS_COLORS[status], lineHeight: 1 }}>{STATUS_ICONS[status]}</span>,
  }));

  // The largest databases, largest on top - a dead one among them is storage to free.
  const largest = useMemo(
    () => [...rows].sort((a, b) => (b.size_bytes ?? 0) - (a.size_bytes ?? 0)).slice(0, LARGEST).reverse(),
    [rows],
  );

  const columns: SearchableColumn<DatabaseRow>[] = [
    {
      name: t('dbu_col_database'),
      selector: (row) => row.database,
      sortable: true,
      grow: 2,
      cell: (row) => (
        <div className="small">
          <div className="fw-semibold">{projectLabel(row)}</div>
          <code className="text-muted">{row.database}</code>
        </div>
      ),
      searchText: (row) => `${row.database} ${projectLabel(row)}`,
    },
    {
      name: t('dbu_col_locations'),
      selector: (row) => row.name ?? '',
      sortable: true,
      grow: 2,
      cell: (row) => <span className="small text-truncate" title={row.name ?? undefined}>{row.name ?? '–'}</span>,
    },
    {
      name: t('dbu_col_status'),
      selector: (row) => STATUS_ORDER.indexOf(row.status),
      sortable: true,
      cell: (row) => <StatusBadge status={row.status} label={statusLabel(row.status)} />,
      searchText: (row) => statusLabel(row.status),
      grow: 1.4,
    },
    {
      name: t('dbu_col_devices'),
      selector: (row) => row.devices,
      sortable: true,
      right: true,
      cell: (row) => <span className="small staff-insights-num">{row.devices}</span>,
    },
    {
      name: t('dbu_col_measurements'),
      selector: (row) => row.measurements ?? -1,
      sortable: true,
      right: true,
      cell: (row) => (
        <span className="small staff-insights-num" title={row.stats_at ? t('dbu_counted_at', { at: formatDate(row.stats_at, 'dateTime') }) : undefined}>
          {row.measurements == null ? '–' : row.measurements.toLocaleString()}
        </span>
      ),
    },
    {
      name: t('dbu_col_last_measurement'),
      selector: (row) => row.last_measurement_at ?? '',
      sortable: true,
      grow: 1.3,
      cell: (row) => <span className="small">{row.last_measurement_at ? formatDate(row.last_measurement_at, 'dateTime') : '–'}</span>,
    },
    {
      id: 'size',
      name: t('dbu_col_size'),
      selector: (row) => row.size_bytes ?? 0,
      sortable: true,
      right: true,
      cell: (row) => <span className="small staff-insights-num">{formatBytes(row.size_bytes)}</span>,
    },
  ];

  const filterOptions: Array<{ value: Filter; label: string }> = [
    { value: 'all', label: t('dbu_filter_all', { count: rows.length }) },
    { value: 'dead', label: t('dbu_filter_dead', { count: usage?.dead ?? 0 }) },
    ...STATUS_ORDER.filter((status) => (usage?.totals[status]?.databases ?? 0) > 0).map((status) => ({
      value: status,
      label: `${statusLabel(status)} (${usage?.totals[status]?.databases ?? 0})`,
    })),
  ];

  return (
    <div className="staff-insights" data-testid="page-database-usage">
      <div className="staff-insights-head">
        <div>
          <h1 className="staff-insights-title">{t('dbu_title')}</h1>
          <div className="staff-insights-subtitle">
            {usage
              ? t('dbu_subtitle', { at: formatDate(usage.generated_at, 'dateTime'), days: usage.stale_days })
              : t('dbu_intro')}
          </div>
        </div>
        <PillButton
          label={t('dbu_refresh')}
          icon={loading ? <Spinner animation="border" size="sm" /> : <ArrowClockwise />}
          onClick={() => {
            setLoading(true);
            load(true);
          }}
          disabled={loading}
          variant="ghost"
          title={t('dbu_refresh_hint')}
          testId="database-usage-refresh"
        />
      </div>

      <KpiStrip tiles={kpis} testId="database-usage-kpis" />

      <div className={`staff-insights-grid${loading && usage ? ' staff-insights-busy' : ''}`}>
        <PanelCard
          title={t('dbu_by_status')}
          actions={
            <SegmentedControl
              options={[
                { value: 'count', label: t('dbu_pie_count') },
                { value: 'size', label: t('dbu_pie_size') },
              ]}
              value={pieBy}
              onChange={(value) => setPieBy(value as 'count' | 'size')}
              testId="database-usage-pie-by"
            />
          }
          testId="database-usage-status"
        >
          {!usage ? (
            <div className="staff-insights-placeholder"><Spinner animation="border" size="sm" /></div>
          ) : (
            <DonutChart
              slices={slices}
              centerLabel={pieBy === 'count' ? t('dbu_pie_center_count') : t('dbu_pie_center_size')}
              ariaLabel={t('dbu_by_status')}
              formatValue={pieBy === 'count' ? String : formatBytes}
              onSelect={(status) => setFilter(status as Status)}
              selectTitle={t('dbu_pie_select')}
              emptyLabel={t('dbu_empty')}
              testId="database-usage-pie"
            />
          )}
          <div className="staff-insights-note">{t('dbu_status_help', { days: usage?.stale_days ?? 30 })}</div>
        </PanelCard>

        <PanelCard title={t('dbu_largest', { count: LARGEST })} testId="database-usage-largest">
          {!usage ? (
            <div className="staff-insights-placeholder"><Spinner animation="border" size="sm" /></div>
          ) : largest.length === 0 ? (
            <div className="small text-muted py-2">{t('dbu_empty')}</div>
          ) : (
            <PlotlyTouchScroll>
              <Plot
                data={[
                  {
                    type: 'bar',
                    orientation: 'h',
                    x: largest.map((row) => (row.size_bytes ?? 0) / 1024 ** 2),
                    y: largest.map((row) => `${projectLabel(row)} ${row.name ? `· ${row.name.slice(0, 28)}` : ''}`),
                    marker: { color: largest.map((row) => STATUS_COLORS[row.status]) },
                    customdata: largest.map((row) => [formatBytes(row.size_bytes), statusLabel(row.status), row.devices]),
                    hovertemplate: `%{y}<br>%{customdata[0]} · %{customdata[1]}<br>${t('dbu_col_devices')}: %{customdata[2]}<extra></extra>`,
                  },
                ]}
                layout={baseLayout(Math.max(220, largest.length * 24 + 40), {
                  xaxis: { title: { text: 'MB' }, rangemode: 'tozero' },
                  yaxis: { gridcolor: 'transparent', ticks: '' },
                })}
                config={plotConfig}
                style={{ width: '100%' }}
                useResizeHandler
              />
            </PlotlyTouchScroll>
          )}
          <div className="staff-insights-note">{t('dbu_largest_note')}</div>
        </PanelCard>
      </div>

      <PanelCard title={t('dbu_table_title')} testId="database-usage-table">
        <SearchableDataTable
          columns={columns}
          data={shownRows}
          keyField="database"
          defaultSortFieldId="size"
          defaultSortAsc={false}
          pagination
          paginationPerPage={50}
          paginationRowsPerPageOptions={[25, 50, 100, 500]}
          customStyles={progeoTableStyles}
          progressPending={loading && !usage}
          progressComponent={<div className="py-4"><Spinner animation="border" size="sm" /></div>}
          noDataComponent={<div className="small text-muted py-3">{t('dbu_empty')}</div>}
          toolbar={
            <SegmentedControl
              options={filterOptions}
              value={filter}
              onChange={(value) => setFilter(value as Filter)}
              testId="database-usage-filter"
            />
          }
          testId="database-usage-rows"
        />
      </PanelCard>
    </div>
  );
};

export default DatabaseUsageView;
