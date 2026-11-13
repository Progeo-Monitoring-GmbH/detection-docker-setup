import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Alert, Button, Form, Modal, ProgressBar, Spinner } from 'react-bootstrap';
import {
  ArrowClockwise,
  Clipboard,
  ListCheck,
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
import { showErrorBar, showSuccessBar } from '../../components/ui/Snackbar.jsx';
import DonutChart from '../../components/ui/kit/DonutChart';
import KpiStrip from '../../components/ui/kit/KpiStrip';
import PanelCard from '../../components/ui/kit/PanelCard';
import PillButton from '../../components/ui/kit/PillButton';
import SearchableDataTable, { progeoTableStyles, type SearchableColumn } from '../../components/ui/kit/SearchableDataTable';
import SegmentedControl from '../../components/ui/kit/SegmentedControl';
import { PlotlyTouchScroll } from '../../components/ui/wheelZoom';
import { formatDate } from '../dateFormat';
import { runChunks } from '../deviceStatisticsBuild';
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

/** What a run (plan, cached or finished result) says besides the rows. */
type Usage = {
  generated_at: string;
  stale_days: number;
  /** PROJECT_DB_SPLIT: off, the app still works in the main database. */
  split_enabled: boolean;
  default: { database: string; size_bytes: number | null };
};

/** The chunked build while it runs: chunks and databases done. */
type BuildProgress = { chunks: number; chunksDone: number; databases: number; databasesDone: number };

const USAGE_URL = '/v1/database-usage/';
// Chunk requests at a time - each asks its databases in parallel on the server.
const CHUNK_CONCURRENCY = 2;

const usageOf = (data: Record<string, unknown>): Usage => ({
  generated_at: String(data.generated_at ?? ''),
  stale_days: Number(data.stale_days) || 30,
  split_enabled: Boolean(data.split_enabled),
  default: (data.default ?? { database: '', size_bytes: null }) as Usage['default'],
});

const reasonOf = (error: unknown) =>
  (error as { response?: { data?: { reason?: string } } })?.response?.data?.reason ?? (error as Error)?.message;

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

/** What wipe_project_databases takes: the project id ("unknown"), else the database name. */
const scriptId = (row: DatabaseRow) => (row.project != null ? String(row.project) : row.database);

/** Statuses of databases in use - the wipe script refuses them without --allow-active. */
const IN_USE: Status[] = ['active', 'stale'];

/**
 * The selected databases' ids, one per line, to copy - with how to hand
 * them to manage.py wipe_project_databases (by hand, on the server; it shows
 * every database in detail and asks before it deletes anything).
 */
const SelectedIdsModal = ({ rows, onHide }: { rows: DatabaseRow[] | null; onHide: () => void }) => {
  const { t } = useTranslation();
  const { enqueueSnackbar } = useSnackbar();
  const ids = (rows ?? []).map(scriptId).join('\n');
  const inUse = (rows ?? []).filter((row) => IN_USE.includes(row.status));
  const unreadable = (rows ?? []).filter((row) => row.status === 'error');
  const command = 'python manage.py wipe_project_databases --file <file with the ids>';
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(ids);
      showSuccessBar(enqueueSnackbar, t('dbu_ids_copied', { count: rows?.length ?? 0 }));
    } catch {
      showErrorBar(enqueueSnackbar, t('dbu_ids_copy_failed'));
    }
  };
  return (
    <Modal show={rows != null} onHide={onHide} size="lg" data-testid="database-usage-ids-modal">
      <Modal.Header closeButton>
        <Modal.Title as="h5">{t('dbu_ids_title', { count: rows?.length ?? 0 })}</Modal.Title>
      </Modal.Header>
      <Modal.Body className="d-flex flex-column gap-3">
        <Form.Group controlId="database-usage-ids">
          <Form.Label className="small text-muted">{t('dbu_ids_label')}</Form.Label>
          <Form.Control
            as="textarea"
            readOnly
            rows={Math.min(14, Math.max(4, rows?.length ?? 0))}
            value={ids}
            className="font-monospace"
            onFocus={(event) => event.currentTarget.select()}
            data-testid="database-usage-ids"
          />
        </Form.Group>
        {inUse.length > 0 && (
          <Alert variant="warning" className="mb-0 small" data-testid="database-usage-ids-in-use">
            {t('dbu_ids_in_use', { count: inUse.length, ids: inUse.map(scriptId).join(', ') })}
          </Alert>
        )}
        {unreadable.length > 0 && (
          <Alert variant="secondary" className="mb-0 small">
            {t('dbu_ids_unreadable', { count: unreadable.length })}
          </Alert>
        )}
        <div className="small">
          <div className="text-muted mb-1">{t('dbu_ids_how')}</div>
          <code className="d-block p-2 rounded staff-insights-command" data-testid="database-usage-ids-command">
            {command}
          </code>
          <div className="text-muted mt-1">{t('dbu_ids_safety')}</div>
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="outline-secondary" onClick={onHide} data-testid="database-usage-ids-close">
          {t('dbu_close')}
        </Button>
        <Button variant="primary" onClick={() => void copy()} data-testid="database-usage-ids-copy">
          <Clipboard className="me-1" aria-hidden />
          {t('dbu_ids_copy')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
};

const projectLabel = (row: DatabaseRow) =>
  row.project == null ? row.database : typeof row.project === 'number' ? `#${row.project}` : String(row.project);

/**
 * Staff (sidebar: Database usage): how the project databases are used - by
 * status (pie: count or storage), the largest ones and every database in a
 * table. Dead databases have no devices or never received a measurement.
 * Data: GET /v1/database-usage/ - the cached result, else built chunk by
 * chunk (a few databases per request, as /device/statistics/): the tiles,
 * charts and table fill up with every chunk, a bar shows the progress.
 * Refresh builds it anew.
 */
const DatabaseUsageView = () => {
  const { t } = useTranslation();
  const auth = useAuth();
  const [usage, setUsage] = useState<Usage | null>(null);
  // The databases so far - all of them once the build is done.
  const [rows, setRows] = useState<DatabaseRow[]>([]);
  const [progress, setProgress] = useState<BuildProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pieBy, setPieBy] = useState<'count' | 'size'>('count');
  const [filter, setFilter] = useState<Filter>('all');
  // Selected databases (by name) - also those the filter hides; "Show
  // selected IDs" lists them for the wipe script.
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [idsShown, setIdsShown] = useState<DatabaseRow[] | null>(null);
  const requestRef = useRef(0);
  const inFlight = useRef(false);
  const authRef = useRef(auth);
  useEffect(() => {
    authRef.current = auth;
  }, [auth]);

  const get = useCallback(
    (query: string) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        void axiosConfig.perform_get(
          authRef.current,
          `${USAGE_URL}?${query}`,
          (response) => resolve((response?.data ?? {}) as Record<string, unknown>),
          reject,
        );
      }),
    [],
  );

  /**
   * The cached result, else a chunked build: every chunk's rows are shown
   * as they come; finish merges and caches them on the server. Loading,
   * the error and the rows are reset by the caller (Refresh) - not here,
   * the first call comes from an effect.
   */
  const load = useCallback(
    async (refresh: boolean) => {
      if (inFlight.current) {
        return;
      }
      inFlight.current = true;
      const request = ++requestRef.current;
      const stale = () => request !== requestRef.current;
      try {
        const plan = await get(`plan=1${refresh ? '&refresh=1' : ''}`);
        if (stale()) {
          return;
        }
        setUsage(usageOf(plan));
        if (plan.cached) {
          setRows((plan.databases ?? []) as DatabaseRow[]);
          return;
        }
        const build = String(plan.build);
        const chunks = Number(plan.chunks) || 0;
        setRows([]);
        setProgress({ chunks, chunksDone: 0, databases: Number(plan.databases) || 0, databasesDone: 0 });
        await runChunks(
          chunks,
          CHUNK_CONCURRENCY,
          async (index) => {
            const chunk = await get(`build=${build}&chunk=${index}`);
            if (stale()) {
              return;
            }
            const chunkRows = (chunk.rows ?? []) as DatabaseRow[];
            setRows((current) => [...current, ...chunkRows]);
            setProgress(
              (current) =>
                current && {
                  ...current,
                  chunksDone: current.chunksDone + 1,
                  databasesDone: current.databasesDone + chunkRows.length,
                },
            );
          },
          stale,
        );
        if (stale()) {
          return;
        }
        const result = await get(`build=${build}&finish=1`);
        if (!stale()) {
          setUsage(usageOf(result));
          setRows((result.databases ?? []) as DatabaseRow[]);
        }
      } catch (requestError) {
        if (!stale()) {
          setError(reasonOf(requestError) || 'Unknown error');
        }
      } finally {
        if (!stale()) {
          inFlight.current = false;
          setLoading(false);
          setProgress(null);
        }
      }
    },
    [get],
  );
  useEffect(() => {
    void load(false);
  }, [load]);

  const refresh = () => {
    if (inFlight.current) {
      return;
    }
    setLoading(true);
    setError(null);
    void load(true);
  };

  const statusLabel = useCallback((status: Status) => t(`dbu_status_${status}`), [t]);
  // While a build runs, no rows yet means: still scanning.
  const emptyText = progress || loading ? t('dbu_waiting') : t('dbu_empty');
  // Counted from the rows - while a build runs, those of the chunks so far.
  const totals = useMemo(() => {
    const counts = Object.fromEntries(
      STATUS_ORDER.map((status) => [status, { databases: 0, size_bytes: 0 }]),
    ) as Record<Status, { databases: number; size_bytes: number }>;
    rows.forEach((row) => {
      const total = counts[row.status] ?? counts.error;
      total.databases += 1;
      total.size_bytes += row.size_bytes ?? 0;
    });
    return counts;
  }, [rows]);
  const dead = DEAD.reduce((sum, status) => sum + totals[status].databases, 0);
  const shownRows = useMemo(
    () =>
      filter === 'all'
        ? rows
        : rows.filter((row) => (filter === 'dead' ? DEAD.includes(row.status) : row.status === filter)),
    [rows, filter],
  );
  const selectedRows = useMemo(() => rows.filter((row) => selected.has(row.database)), [rows, selected]);
  const projectSize = rows.reduce((sum, row) => sum + (row.size_bytes ?? 0), 0);
  const deadSize = DEAD.reduce((sum, status) => sum + totals[status].size_bytes, 0);

  const kpis = [
    {
      label: t('dbu_kpi_databases'),
      value: usage ? String(rows.length) : '–',
      note: progress ? t('dbu_kpi_scanned', { total: progress.databases }) : undefined,
    },
    {
      label: t('dbu_kpi_dead'),
      value: usage ? String(dead) : '–',
      note: usage ? t('dbu_kpi_dead_note', { size: formatBytes(deadSize) }) : undefined,
      valueColor: dead ? STATUS_COLORS.no_devices : undefined,
    },
    {
      label: t('dbu_kpi_stale'),
      value: usage ? String(totals.stale.databases) : '–',
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
    count: pieBy === 'count' ? totals[status].databases : totals[status].size_bytes,
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
    { value: 'dead', label: t('dbu_filter_dead', { count: dead }) },
    ...STATUS_ORDER.filter((status) => totals[status].databases > 0).map((status) => ({
      value: status,
      label: `${statusLabel(status)} (${totals[status].databases})`,
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
          onClick={refresh}
          disabled={loading}
          variant="ghost"
          title={t('dbu_refresh_hint')}
          testId="database-usage-refresh"
        />
      </div>

      {progress && (
        <div aria-live="polite" data-testid="database-usage-progress">
          <div className="d-flex justify-content-between staff-insights-subtitle mb-1">
            <span>{t('dbu_scanning', { done: progress.databasesDone, total: progress.databases })}</span>
            <span>{progress.databases ? Math.round((progress.databasesDone / progress.databases) * 100) : 0} %</span>
          </div>
          <ProgressBar
            now={progress.databasesDone}
            max={Math.max(progress.databases, 1)}
            animated={progress.databasesDone < progress.databases}
            className="staff-insights-progress"
          />
          {progress.chunks > 0 && progress.chunksDone === progress.chunks && (
            <div className="staff-insights-note">{t('dbu_merging')}</div>
          )}
        </div>
      )}
      {error && (
        <Alert variant="danger" className="mb-0 small" data-testid="database-usage-error">
          {t('dbu_load_failed')}: {error}
        </Alert>
      )}

      {usage && !usage.split_enabled && (
        <Alert variant="warning" className="mb-0 small" data-testid="database-usage-split-off">
          {t('dbu_split_off')}
        </Alert>
      )}

      <KpiStrip tiles={kpis} testId="database-usage-kpis" />

      <div className="staff-insights-grid">
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
              emptyLabel={emptyText}
              testId="database-usage-pie"
            />
          )}
          <div className="staff-insights-note">{t('dbu_status_help', { days: usage?.stale_days ?? 30 })}</div>
        </PanelCard>

        <PanelCard title={t('dbu_largest', { count: LARGEST })} testId="database-usage-largest">
          {!usage ? (
            <div className="staff-insights-placeholder"><Spinner animation="border" size="sm" /></div>
          ) : largest.length === 0 ? (
            <div className="small text-muted py-2">{emptyText}</div>
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
          noDataComponent={<div className="small text-muted py-3">{emptyText}</div>}
          selection={{ rowKey: (row) => row.database, selected, onChange: setSelected }}
          toolbar={
            <div className="d-flex flex-wrap align-items-center gap-2">
              <SegmentedControl
                options={filterOptions}
                value={filter}
                onChange={(value) => setFilter(value as Filter)}
                testId="database-usage-filter"
              />
              <PillButton
                label={t('dbu_show_ids', { count: selectedRows.length })}
                icon={<ListCheck />}
                onClick={() => setIdsShown(selectedRows)}
                disabled={selectedRows.length === 0}
                variant="ghost"
                testId="database-usage-show-ids"
              />
              {selectedRows.length > 0 && (
                <PillButton
                  label={t('dbu_clear_selection')}
                  onClick={() => setSelected(new Set())}
                  variant="ghost"
                  testId="database-usage-clear-selection"
                />
              )}
            </div>
          }
          testId="database-usage-rows"
        />
      </PanelCard>

      <SelectedIdsModal rows={idsShown} onHide={() => setIdsShown(null)} />
    </div>
  );
};

export default DatabaseUsageView;
