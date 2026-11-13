import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Alert, Badge, Button, ProgressBar, Spinner } from 'react-bootstrap';
import { ArrowRepeat, PencilSquare } from 'react-bootstrap-icons';
import DataTable, { type TableColumn } from 'react-data-table-component';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useSnackbar } from 'notistack';
import { useAuth } from '../../hooks/CoreAuthProvider';
import axiosConfig from '../axiosConfig';
import KpiStrip from '../components/ui/kit/KpiStrip';
import PanelCard from '../components/ui/kit/PanelCard';
import PillButton from '../components/ui/kit/PillButton';
import SegmentedControl from '../components/ui/kit/SegmentedControl';
import ConfirmDialog from '../components/ui/kit/ConfirmDialog';
import {
  errorReason,
  showRequestError,
  showSuccessBar,
} from '../components/ui/Snackbar.jsx';
import { formatDate, formatRelativeTime } from './dateFormat';
import { plotTheme } from '../styles/plotTheme';
import { staffFlags } from './access';
import { getProjectTypeLabel } from './projectType';
import { addCounts, mergeTypeCounts, runChunks } from './deviceStatisticsBuild';
import { childTestId, repeatedTestId } from '../testIds';
import './DeviceStatisticsView.css';

/** A row of GET /v1/status/device_statistics/ - devices.* and by_type values. */
type StatisticsDevice = {
  id: number;
  /** Database holding the row (ids are only unique per project database). */
  database: string;
  raw_hash: string;
  display_name: string | null;
  type: string | null;
  hardware: string | null;
  chip_id: string | null;
  device_ip: string | null;
  location_id: number | null;
  location_name: string | null;
  project_id: number | null;
  last_measurement_at: string | null;
  measured_24h: boolean;
  missing_lageplan: boolean;
  dead: boolean;
};

/** A row of locations.* of GET /v1/status/device_statistics/. */
type StatisticsLocation = {
  id: number;
  database: string;
  name: string | null;
  project_id: number | null;
  device_count: number;
  last_measurement_at: string | null;
  has_lageplan: boolean;
  unused: boolean;
  dead: boolean;
};

type StatisticsTotals = {
  devices: number;
  locations: number;
  with_chip_id: number;
  without_chip_id: number;
  measured_24h: number;
  not_measured_24h: number;
  missing_lageplan: number;
  dead: number;
  unused_locations: number;
  locations_missing_lageplan: number;
};

type StatisticsTypeRow = {
  type: string;
  label: string;
  count: number;
};

/** One section response of GET /v1/status/device_statistics/?section=... */
type DeviceStatisticsSection = {
  generated_at: string | null;
  totals: StatisticsTotals;
  by_type: StatisticsTypeRow[];
  devices: {
    by_type: Record<string, StatisticsDevice[]>;
    with_chip_id: StatisticsDevice[];
    without_chip_id: StatisticsDevice[];
    measured_24h: StatisticsDevice[];
    not_measured_24h: StatisticsDevice[];
    missing_lageplan: StatisticsDevice[];
    dead: StatisticsDevice[];
  };
  locations: Record<string, StatisticsLocation[]>;
};

/** The API section a tab requests. `by_type` also carries the overview. */
type StatisticsRequestSection =
  | 'overview'
  | 'by_type'
  | 'chip_id'
  | 'measured'
  | 'lageplan'
  | 'dead'
  | 'unused_locations'
  | 'locations_missing_lageplan'
  | 'dead_locations';

type StatsSection =
  | 'by_type'
  | 'chip_id'
  | 'measured'
  | 'lageplan'
  | 'dead'
  | 'unused_locations'
  | 'locations_missing_lageplan'
  | 'dead_locations';

/** One selected table row; `database` addresses it for bulk deletion. */
type SelectedRow = {
  kind: 'device' | 'location';
  id: number;
  database: string;
};

const EMPTY_TOTALS: StatisticsTotals = {
  devices: 0,
  locations: 0,
  with_chip_id: 0,
  without_chip_id: 0,
  measured_24h: 0,
  not_measured_24h: 0,
  missing_lageplan: 0,
  dead: 0,
  unused_locations: 0,
  locations_missing_lageplan: 0,
};

/** Missing lists/keys become empty instead of crashing the page. */
const normalizeSection = (raw: unknown): DeviceStatisticsSection => {
  const data = (raw || {}) as Partial<DeviceStatisticsSection>;
  const devices = (data.devices ?? {}) as Partial<
    DeviceStatisticsSection['devices']
  >;
  return {
    generated_at: data.generated_at ?? null,
    totals: { ...EMPTY_TOTALS, ...(data.totals ?? {}) },
    by_type: data.by_type ?? [],
    devices: {
      by_type: devices.by_type ?? {},
      with_chip_id: devices.with_chip_id ?? [],
      without_chip_id: devices.without_chip_id ?? [],
      measured_24h: devices.measured_24h ?? [],
      not_measured_24h: devices.not_measured_24h ?? [],
      missing_lageplan: devices.missing_lageplan ?? [],
      dead: devices.dead ?? [],
    },
    locations: data.locations ?? {},
  };
};

/** The API section a tab needs (the overview - totals, type counts - comes with the build). */
const REQUEST_SECTION: Record<StatsSection, StatisticsRequestSection> = {
  by_type: 'by_type',
  chip_id: 'chip_id',
  measured: 'measured',
  lageplan: 'lageplan',
  dead: 'dead',
  unused_locations: 'unused_locations',
  locations_missing_lageplan: 'locations_missing_lageplan',
  dead_locations: 'dead_locations',
};

const STATISTICS_URL = '/v1/status/device_statistics/';
// Chunk requests at a time - each already queries its databases in parallel.
const CHUNK_CONCURRENCY = 2;

/** The chunked build while it runs: chunks/databases done, the counts so far. */
type BuildProgress = {
  chunks: number;
  chunksDone: number;
  databases: number;
  databasesDone: number;
  totals: StatisticsTotals;
  byType: StatisticsTypeRow[];
};

const RED = '#B42318';
const AMBER = '#B54708';

/** Dense rows are the point of this page - don't waste card height. */
const COMPACT_TABLE_STYLES = {
  rows: { style: { minHeight: '30px' } },
  cells: { style: { padding: '3px 8px' } },
  headCells: { style: { padding: '4px 8px', fontSize: '12px' } },
};

/** Small heading above one list inside a tab. */
const ListSection = ({
  title,
  children,
  testKey,
}: {
  title: string;
  children: ReactNode;
  /** data-test-key of the section (src/testIds.ts). */
  testKey: string;
}) => (
  <div className="mb-3" {...repeatedTestId('device-stats-list', testKey)}>
    <div className="device-stats-section-title">
      {title}
    </div>
    {children}
  </div>
);

/** Django admin change form for a row (superusers only in the UI). */
const adminEditUrl = (
  model: 'progeodevice' | 'progeolocation',
  row: { id: number; database: string },
) =>
  `/aadmin/progeo/${model}/${row.id}/change/?db=${encodeURIComponent(row.database)}`;

/** Re-render the relative "last measurement" labels every 30 s. */
const useNow = (intervalMs = 30_000) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
};

// The device's location in the device overview (the old /device/:id/detail
// view is retired).
const deviceDetailUrl = (row: StatisticsDevice) =>
  `/device/overview${row.location_id != null ? `?location=${row.location_id}` : ''}`;

const locationDetailUrl = (row: Pick<StatisticsLocation, 'id'>) =>
  `/location/${row.id}/status`;

/** The shared device table (device, type, chip id, location, last measurement). */
const DeviceList = ({
  rows,
  selectable = false,
  selectionKey,
  onSelectionChange,
  showAdminEdit = false,
  testKey,
}: {
  rows: StatisticsDevice[];
  selectable?: boolean;
  selectionKey?: string;
  onSelectionChange?: (rows: StatisticsDevice[]) => void;
  showAdminEdit?: boolean;
  /** data-test-key of the list's empty state (src/testIds.ts). */
  testKey: string;
}) => {
  const { t } = useTranslation();
  const now = useNow();

  if (!rows.length) {
    return (
      <div className="small text-muted py-2" {...repeatedTestId('device-stats-list-empty', testKey)}>
        {t('device_stats_empty')}
      </div>
    );
  }

  const columns: TableColumn<StatisticsDevice>[] = [
    {
      name: t('device_stats_col_device'),
      selector: (row) => row.display_name || row.raw_hash,
      sortable: true,
      cell: (row) => (
        <div className="small">
          <Link
            to={deviceDetailUrl(row)}
            title={t('device_stats_open_device')}
            {...repeatedTestId('device-stats-device-link', `${row.database}-${row.id}`)}
          >
            {row.display_name || row.raw_hash}
          </Link>
          <code className="text-muted d-block">{row.raw_hash}</code>
        </div>
      ),
      minWidth: '150px',
      wrap: true,
    },
    {
      name: t('device_stats_col_type'),
      selector: (row) => row.type ?? '',
      sortable: true,
      cell: (row) => (
        <span className="small" title={row.hardware ?? undefined}>
          {row.type || t('devices_type_unset')}
          {row.hardware ? (
            <span className="text-muted"> · {row.hardware}</span>
          ) : null}
        </span>
      ),
      width: '130px',
      wrap: true,
    },
    {
      name: t('device_stats_col_chip_id'),
      selector: (row) => row.chip_id ?? '',
      sortable: true,
      cell: (row) =>
        row.chip_id ? (
          <code className="small">{row.chip_id}</code>
        ) : (
          <span className="device-stats-muted">–</span>
        ),
      width: '110px',
    },
    {
      name: t('device_stats_col_location'),
      selector: (row) => row.location_name ?? '',
      sortable: true,
      cell: (row) => (
        <div className="small">
          {row.location_id != null ? (
            <Link
              to={locationDetailUrl({ id: row.location_id })}
              title={t('device_stats_open_location')}
              {...repeatedTestId('device-stats-device-location-link', `${row.database}-${row.id}`)}
            >
              {row.location_name || '–'}
            </Link>
          ) : (
            <span>{row.location_name || '–'}</span>
          )}
          {row.project_id != null && (
            <span className="text-muted"> #{row.project_id}</span>
          )}
        </div>
      ),
      minWidth: '130px',
      wrap: true,
    },
    {
      name: t('device_stats_col_last_measurement'),
      selector: (row) => row.last_measurement_at ?? '',
      sortable: true,
      cell: (row) => (
        <span
          className="small"
          title={formatDate(row.last_measurement_at, 'dateTime')}
        >
          {formatRelativeTime(row.last_measurement_at, now)}
        </span>
      ),
      width: '135px',
    },
    ...(showAdminEdit
      ? [
          {
            name: '',
            sortable: false,
            button: true,
            cell: (row: StatisticsDevice) => (
              <a
                href={adminEditUrl('progeodevice', row)}
                target="_blank"
                rel="noreferrer"
                title={t('device_stats_admin_edit')}
                aria-label={t('device_stats_admin_edit')}
                {...repeatedTestId('device-stats-device-admin-edit', `${row.database}-${row.id}`)}
              >
                <PencilSquare size={14} />
              </a>
            ),
            width: '40px',
          },
        ]
      : []),
  ];

  return (
    <DataTable
      key={selectionKey}
      columns={columns}
      data={rows}
      dense
      customStyles={COMPACT_TABLE_STYLES}
      selectableRows={selectable}
      selectableRowsHighlight
      onSelectedRowsChange={(state: { selectedRows: StatisticsDevice[] }) =>
        onSelectionChange?.(state.selectedRows)
      }
      pagination
      paginationPerPage={8}
      paginationRowsPerPageOptions={[8, 15, 25, 50]}
    />
  );
};

/** The shared location table (location, device count, Lageplan, status). */
const LocationList = ({
  rows,
  selectable = false,
  selectionKey,
  onSelectionChange,
  showAdminEdit = false,
  testKey,
}: {
  rows: StatisticsLocation[];
  selectable?: boolean;
  selectionKey?: string;
  onSelectionChange?: (rows: StatisticsLocation[]) => void;
  showAdminEdit?: boolean;
  /** data-test-key of the list's empty state (src/testIds.ts). */
  testKey: string;
}) => {
  const { t } = useTranslation();
  const now = useNow();

  if (!rows.length) {
    return (
      <div className="small text-muted py-2" {...repeatedTestId('device-stats-list-empty', testKey)}>
        {t('device_stats_empty')}
      </div>
    );
  }

  const columns: TableColumn<StatisticsLocation>[] = [
    {
      name: t('device_stats_col_location'),
      selector: (row) => row.name ?? '',
      sortable: true,
      cell: (row) => (
        <div className="small">
          <Link
            to={locationDetailUrl(row)}
            title={t('device_stats_open_location')}
            {...repeatedTestId('device-stats-location-link', `${row.database}-${row.id}`)}
          >
            {row.name || '–'}
          </Link>
          {row.project_id != null && (
            <span className="text-muted"> #{row.project_id}</span>
          )}
        </div>
      ),
      minWidth: '150px',
      wrap: true,
    },
    {
      name: t('device_stats_col_devices'),
      selector: (row) => row.device_count,
      sortable: true,
      cell: (row) => <span className="small">{row.device_count}</span>,
      width: '90px',
    },
    {
      name: t('device_stats_col_last_measurement'),
      selector: (row) => row.last_measurement_at ?? '',
      sortable: true,
      cell: (row) => (
        <span
          className="small"
          title={formatDate(row.last_measurement_at, 'dateTime')}
        >
          {formatRelativeTime(row.last_measurement_at, now)}
        </span>
      ),
      width: '135px',
    },
    {
      name: t('device_stats_col_lageplan'),
      selector: (row) => (row.has_lageplan ? 1 : 0),
      sortable: true,
      cell: (row) => (
        <Badge bg={row.has_lageplan ? 'success' : 'secondary'}>
          {row.has_lageplan ? t('device_stats_yes') : t('device_stats_no')}
        </Badge>
      ),
      width: '90px',
    },
    {
      name: t('device_stats_col_status'),
      selector: (row) => `${row.unused ? 'unused' : ''} ${row.dead ? 'dead' : ''}`,
      sortable: true,
      cell: (row) => (
        <div className="d-flex flex-wrap gap-1">
          {row.unused ? (
            <Badge bg="warning" text="dark">
              {t('device_stats_unused')}
            </Badge>
          ) : null}
          {row.dead ? <Badge bg="danger">{t('device_stats_dead')}</Badge> : null}
          {!row.unused && !row.dead ? (
            <span className="device-stats-muted">–</span>
          ) : null}
        </div>
      ),
      width: '130px',
    },
    ...(showAdminEdit
      ? [
          {
            name: '',
            sortable: false,
            button: true,
            cell: (row: StatisticsLocation) => (
              <a
                href={adminEditUrl('progeolocation', row)}
                target="_blank"
                rel="noreferrer"
                title={t('device_stats_admin_edit')}
                aria-label={t('device_stats_admin_edit')}
                {...repeatedTestId('device-stats-location-admin-edit', `${row.database}-${row.id}`)}
              >
                <PencilSquare size={14} />
              </a>
            ),
            width: '40px',
          },
        ]
      : []),
  ];

  return (
    <DataTable
      key={selectionKey}
      columns={columns}
      data={rows}
      dense
      customStyles={COMPACT_TABLE_STYLES}
      selectableRows={selectable}
      selectableRowsHighlight
      onSelectedRowsChange={(state: { selectedRows: StatisticsLocation[] }) =>
        onSelectionChange?.(state.selectedRows)
      }
      pagination
      paginationPerPage={8}
      paginationRowsPerPageOptions={[8, 15, 25, 50]}
    />
  );
};
const PIE_COLORS = [
  plotTheme.brandBlue,
  plotTheme.brandOrange,
  plotTheme.contrastGreen,
  plotTheme.contrastViolet,
  plotTheme.contrastCyan,
  plotTheme.contrastYellow,
  '#6b6b6b',
];

type DonutSlice = { key: string; label: string; count: number; color: string };

/** A compact donut with its legend beside it; slices/legend entries are clickable. */
const DonutChart = ({
  slices,
  centerLabel,
  ariaLabel,
  onSelect,
  selectTitle,
  testId,
}: {
  slices: DonutSlice[];
  centerLabel: string;
  ariaLabel: string;
  onSelect?: (key: string) => void;
  selectTitle?: string;
  /** data-testid of the chart; slices "-slice", legend entries "-legend-item" (key: the slice key). */
  testId: string;
}) => {
  const { t } = useTranslation();
  const shown = slices.filter((slice) => slice.count > 0);
  const total = shown.reduce((sum, slice) => sum + slice.count, 0);
  if (total <= 0) {
    return <div className="small text-muted py-2" data-testid={childTestId(testId, 'empty')}>{t('device_stats_empty')}</div>;
  }

  const center = 60;
  const radius = 54;
  const point = (value: number) => [center + radius * Math.cos(value), center + radius * Math.sin(value)] as const;
  // Start angle of each slice: the sum of the ones before, from 12 o'clock.
  const starts = shown.map(
    (_, index) => -Math.PI / 2 + (shown.slice(0, index).reduce((sum, slice) => sum + slice.count, 0) / total) * Math.PI * 2,
  );
  const segments = shown.map((slice, index) => {
    const sweep = (slice.count / total) * Math.PI * 2;
    const [x1, y1] = point(starts[index]);
    const [x2, y2] = point(starts[index] + sweep);
    return {
      slice,
      percent: Math.round((slice.count / total) * 100),
      // A single slice is a full circle.
      path:
        shown.length === 1
          ? null
          : `M ${center} ${center} L ${x1} ${y1} A ${radius} ${radius} 0 ${sweep > Math.PI ? 1 : 0} 1 ${x2} ${y2} Z`,
    };
  });
  const clickable = onSelect ? 'device-stats-donut-clickable' : undefined;

  return (
    <div className="d-flex align-items-center gap-3" data-testid={testId}>
      <svg width={130} height={130} viewBox="0 0 120 120" role="img" aria-label={ariaLabel} className="device-stats-donut">
        {segments.map(({ slice, percent, path }) => {
          const title = (
            <title>
              {slice.label}: {slice.count} · {percent}%
            </title>
          );
          return path ? (
            <path
              key={slice.key}
              d={path}
              fill={slice.color}
              stroke="var(--progeo-panel-bg)"
              strokeWidth={1.5}
              className={clickable}
              onClick={() => onSelect?.(slice.key)}
              {...repeatedTestId(`${testId}-slice`, slice.key)}
            >
              {title}
            </path>
          ) : (
            <circle
              key={slice.key}
              cx={center}
              cy={center}
              r={radius}
              fill={slice.color}
              className={clickable}
              onClick={() => onSelect?.(slice.key)}
              {...repeatedTestId(`${testId}-slice`, slice.key)}
            >
              {title}
            </circle>
          );
        })}
        <circle cx={center} cy={center} r={31} fill="var(--progeo-panel-bg)" pointerEvents="none" />
        <text x={center} y={center + 1} textAnchor="middle" className="device-stats-donut-total" data-testid={childTestId(testId, 'total')}>
          {total}
        </text>
        <text x={center} y={center + 14} textAnchor="middle" className="device-stats-donut-label">
          {centerLabel}
        </text>
      </svg>
      <div className="d-flex flex-column device-stats-donut-legend">
        {segments.map(({ slice, percent }) => (
          <button
            key={slice.key}
            type="button"
            disabled={!onSelect}
            onClick={() => onSelect?.(slice.key)}
            title={selectTitle}
            className={onSelect ? 'device-stats-legend-item device-stats-legend-item--clickable' : 'device-stats-legend-item'}
            {...repeatedTestId(`${testId}-legend-item`, slice.key)}
          >
            <span className="device-stats-legend-swatch" style={{ background: slice.color }} />
            <span className="text-truncate">{slice.label}</span>
            <span className="ms-auto text-muted device-stats-nowrap">
              {slice.count} · {percent}%
            </span>
          </button>
        ))}
      </div>
    </div>
  );
};

/**
 * Staff statistics of all devices and locations (sidebar: Device statistics):
 * totals, the breakdown by device type and the lists that need attention -
 * devices without a chip ID, without a measurement in the last 24 h, without
 * a Lageplan or dead, plus unused/dead locations and locations without a
 * Lageplan. Data comes from GET /v1/status/device_statistics/.
 */
const DeviceStatisticsView = () => {
  const auth = useAuth();
  const { t } = useTranslation();
  const { isStaffOrSuperuser: isStaff, isSuperuser } = staffFlags(auth?.user);
  const { enqueueSnackbar } = useSnackbar();

  // One response per requested API section. The base UI renders before any of
  // them arrives; the by-type tab (overview) is requested first.
  const [sections, setSections] = useState<
    Partial<Record<StatisticsRequestSection, DeviceStatisticsSection>>
  >({});
  const [section, setSection] = useState<StatsSection>('by_type');
  // Type clicked in the pie chart: scroll to its table once the tab renders.
  const [scrollToType, setScrollToType] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selections, setSelections] = useState<Record<string, SelectedRow[]>>({});
  // Remounts the tables after a tab switch/delete, clearing their own checkboxes.
  const [selectionEpoch, setSelectionEpoch] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const requestRef = useRef(0);
  const inFlight = useRef(false);
  const authRef = useRef(auth);
  authRef.current = auth;

  // The running chunked build (null otherwise): progress and counts so far.
  const [progress, setProgress] = useState<BuildProgress | null>(null);

  const get = useCallback(
    (query: string) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        void axiosConfig.perform_get(
          authRef.current,
          `${STATISTICS_URL}?${query}`,
          (response) => resolve((response?.data ?? {}) as Record<string, unknown>),
          reject,
        );
      }),
    [],
  );

  /**
   * The overview: from the server's cached snapshot, else built chunk by
   * chunk (a few project databases per request) - the KPI tiles and the
   * charts fill up with every chunk, the lists follow when all are scanned.
   */
  const loadSnapshot = useCallback(
    async (refresh = false) => {
      if (!isStaff || inFlight.current) {
        return;
      }
      inFlight.current = true;
      const request = ++requestRef.current;
      const stale = () => request !== requestRef.current;
      setLoading(true);
      setError(null);
      setProgress(null);
      try {
        const plan = await get(`plan=1${refresh ? '&refresh=1' : ''}`);
        if (stale()) {
          return;
        }
        if (plan.cached) {
          setSections({ overview: normalizeSection(plan) });
          return;
        }
        const build = String(plan.build);
        const chunks = Number(plan.chunks) || 0;
        setProgress({
          chunks,
          chunksDone: 0,
          databases: Number(plan.databases) || 0,
          databasesDone: 0,
          totals: EMPTY_TOTALS,
          byType: [],
        });
        await runChunks(
          chunks,
          CHUNK_CONCURRENCY,
          async (index) => {
            const chunk = await get(`build=${build}&chunk=${index}`);
            if (stale()) {
              return;
            }
            setProgress(
              (current) =>
                current && {
                  ...current,
                  chunksDone: current.chunksDone + 1,
                  databasesDone: current.databasesDone + (Number(chunk.databases) || 0),
                  totals: addCounts(current.totals, (chunk.totals ?? {}) as Partial<StatisticsTotals>),
                  byType: mergeTypeCounts(current.byType, (chunk.by_type ?? []) as StatisticsTypeRow[]),
                },
            );
          },
          stale,
        );
        if (stale()) {
          return;
        }
        const overview = await get(`build=${build}&finish=1`);
        if (!stale()) {
          setSections({ overview: normalizeSection(overview) });
        }
      } catch (requestError) {
        if (!stale()) {
          setError(errorReason(requestError) || 'Unknown error');
        }
      } finally {
        if (!stale()) {
          inFlight.current = false;
          setLoading(false);
          setProgress(null);
        }
      }
    },
    [isStaff, get],
  );

  /** One tab's lists - from the cached snapshot; expired: build it again. */
  const loadSection = useCallback(
    async (key: StatisticsRequestSection) => {
      if (!isStaff || inFlight.current) {
        return;
      }
      inFlight.current = true;
      const request = ++requestRef.current;
      setLoading(true);
      setError(null);
      let expired = false;
      try {
        const data = await get(`section=${key}&cached_only=1`);
        if (request !== requestRef.current) {
          return;
        }
        if (data.missing) {
          expired = true;
        } else {
          setSections((current) => ({ ...current, [key]: normalizeSection(data) }));
        }
      } catch (requestError) {
        if (request === requestRef.current) {
          setError(errorReason(requestError) || 'Unknown error');
        }
      } finally {
        if (request === requestRef.current) {
          inFlight.current = false;
          setLoading(false);
        }
      }
      if (expired) {
        // The snapshot expired on the server: rebuild it (with progress);
        // the tab effect then asks for this section again.
        setSections({});
        void loadSnapshot(false);
      }
    },
    [isStaff, get, loadSnapshot],
  );

  useEffect(() => {
    if (!isStaff) {
      return;
    }
    // The shell is already on screen; this builds (or reuses) the snapshot.
    void loadSnapshot(false);
    // Once per staff state / auth context.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStaff, loadSnapshot]);

  const requestKey = REQUEST_SECTION[section];
  const hasCurrent = Boolean(sections[requestKey]);

  // Every tab request waits until the overview (the snapshot is built) is
  // there, so switching tabs early cannot start two expensive scans.
  useEffect(() => {
    if (!isStaff || !sections.overview || hasCurrent) {
      return;
    }
    void loadSection(requestKey);
    // Runs when the overview arrives or the tab changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStaff, sections.overview, hasCurrent, requestKey, loadSection]);

  useEffect(() => {
    if (!isStaff || !scrollToType || section !== 'by_type' || !sections.by_type) {
      return;
    }
    document
      .getElementById(`device-stats-type-${scrollToType}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setScrollToType(null);
    // Scroll once, when the target table is actually rendered.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStaff, scrollToType, section, sections.by_type]);

  if (!isStaff) {
    return (
      <div className="text-muted py-5 text-center" data-testid="page-device-statistics">
        {t('device_stats_staff_only')}
      </div>
    );
  }

  const clearSelection = () => {
    setSelections({});
    setSelectionEpoch((epoch) => epoch + 1);
  };

  const chooseSection = (next: StatsSection) => {
    if (loading || inFlight.current || deleting || next === section) {
      return;
    }
    clearSelection();
    setSection(next);
  };

  /** Pie slice/legend: open the by-type tab and scroll to that type's table. */
  const openTypeTable = (type: string) => {
    if (loading || inFlight.current || deleting) {
      return;
    }
    setScrollToType(type);
    if (section !== 'by_type') {
      clearSelection();
      setSection('by_type');
    }
  };

  const refresh = () => {
    if (loading || inFlight.current || deleting) {
      return;
    }
    // A new chunked build replaces the cached snapshot; the tab effect then
    // fetches the current section from it.
    clearSelection();
    setSections({});
    void loadSnapshot(true);
  };

  const selectionHandler =
    (key: string, kind: SelectedRow['kind']) =>
    (rows: Array<StatisticsDevice | StatisticsLocation>) =>
      setSelections((current) => ({
        ...current,
        [key]: rows.map((row) => ({
          kind,
          id: row.id,
          database: row.database,
        })),
      }));

  const selected = Object.values(selections).flat();
  const selectedDevices = selected.filter((row) => row.kind === 'device');
  const selectedLocations = selected.filter((row) => row.kind === 'location');

  const deleteSelected = () => {
    if (loading || inFlight.current || deleting || selected.length === 0) {
      return;
    }
    setConfirmDelete(true);
  };

  const performDelete = () => {
    if (deleting) {
      return;
    }
    setDeleting(true);
    void axiosConfig.perform_post(
      auth,
      '/v1/status/device_statistics/delete/',
      {
        devices: selectedDevices.map(({ id, database }) => ({ id, database })),
        locations: selectedLocations.map(({ id, database }) => ({ id, database })),
      },
      (response) => {
        const data = response?.data || {};
        const deletedDevices = Number(data.deleted_devices ?? 0);
        const deletedLocations = Number(data.deleted_locations ?? 0);
        const skipped = Array.isArray(data.skipped) ? data.skipped : [];
        setDeleting(false);
        setConfirmDelete(false);
        clearSelection();
        showSuccessBar(
          enqueueSnackbar,
          t('device_stats_deleted', {
            devices: deletedDevices,
            locations: deletedLocations,
          }),
        );
        if (skipped.length) {
          enqueueSnackbar(
            t('device_stats_delete_skipped', { count: skipped.length }),
            { variant: 'warning' },
          );
        }
        // Drop the cached snapshot and reload the current tab.
        setSections({});
        void loadSnapshot(true);
      },
      (requestError) => {
        setDeleting(false);
        showRequestError(
          enqueueSnackbar,
          t('device_stats_delete_failed'),
          requestError,
        );
      },
    );
  };

  const current = sections[requestKey] ?? null;
  const overview = sections.overview ?? null;
  // While a build runs: the counts of the chunks scanned so far.
  const live = progress && progress.chunksDone > 0 ? progress : null;
  const totals = current?.totals ?? overview?.totals ?? live?.totals ?? EMPTY_TOTALS;
  const hasTotals = current != null || overview != null || live != null;
  const generatedAt = current?.generated_at ?? overview?.generated_at ?? null;
  const typeRows = overview?.by_type ?? live?.byType ?? [];
  const hasCounts = overview != null || live != null;

  const header = (
    <PanelCard
      testId="device-stats-header"
      title={t('device_stats_title')}
      actions={
        <div className="d-flex align-items-center gap-2 flex-wrap">
          {generatedAt && (
            <span className="small text-muted" data-testid="device-stats-generated-at">
              {t('device_stats_generated_at', {
                date: formatDate(generatedAt, 'dateTime'),
              })}
            </span>
          )}
          {selected.length > 0 && (
            <Button
              size="sm"
              variant="outline-danger"
              onClick={deleteSelected}
              disabled={loading || deleting}
              data-testid="device-stats-delete-selected"
            >
              {t('device_stats_delete_selected', { count: selected.length })}
            </Button>
          )}
          <PillButton
            variant="ghost"
            icon={
              loading ? (
                <Spinner animation="border" size="sm" />
              ) : (
                <ArrowRepeat size={14} />
              )
            }
            label={t('device_stats_refresh')}
            onClick={refresh}
            disabled={loading || deleting}
            testId="device-stats-refresh"
          />
        </div>
      }
    >
      <div className="small device-stats-muted">
        {t('device_stats_hint')}
      </div>
      {progress && (
        <div className="mt-2" aria-live="polite" data-testid="device-stats-progress">
          <div className="d-flex justify-content-between small mb-1 device-stats-muted">
            <span>
              {t('device_stats_scanning', {
                done: progress.databasesDone,
                total: progress.databases,
              })}
            </span>
            <span>
              {progress.databases ? Math.round((progress.databasesDone / progress.databases) * 100) : 0} %
            </span>
          </div>
          <ProgressBar
            now={progress.databasesDone}
            max={Math.max(progress.databases, 1)}
            animated={progress.databasesDone < progress.databases}
            className="device-stats-progress"
          />
          {progress.chunksDone === progress.chunks && (
            <div className="small mt-1 device-stats-muted">
              {t('device_stats_merging')}
            </div>
          )}
        </div>
      )}
      {error && (
        <Alert variant="danger" className="mt-2 mb-0" data-testid="device-stats-error">
          {t('device_stats_load_failed')}: {error}
        </Alert>
      )}
    </PanelCard>
  );

  const sectionOptions = [
    { value: 'by_type', label: t('device_stats_by_type_title') },
    { value: 'chip_id', label: t('device_stats_view_chip_id') },
    { value: 'measured', label: t('device_stats_view_measured') },
    { value: 'lageplan', label: t('device_stats_missing_lageplan') },
    { value: 'dead', label: t('device_stats_dead_devices') },
    { value: 'unused_locations', label: t('device_stats_unused_locations') },
    {
      value: 'locations_missing_lageplan',
      label: t('device_stats_locations_missing_lageplan'),
    },
    { value: 'dead_locations', label: t('device_stats_dead_locations') },
  ];

  // by_type is keyed by the locations' project type (PROJECT_TYPE_CHOICES
  // value as text, "unknown" without one) - shown with the brand labels.
  const typeLabel = (type: string) =>
    getProjectTypeLabel(
      t,
      type === 'unknown' ? 0 : Number(type),
      typeRows.find((row) => row.type === type)?.label,
    );

  const typeGroups = typeRows
    .map((row) => ({
      type: row.type,
      label: typeLabel(row.type),
      rows: sections.by_type?.devices.by_type[row.type] ?? [],
    }))
    .filter((group) => group.rows.length > 0);

  const typeSlices = typeRows.map((row, index) => ({
    key: row.type,
    label: typeLabel(row.type),
    count: row.count,
    color: PIE_COLORS[index % PIE_COLORS.length],
  }));

  // Every device is exactly one of these: measured within 24 h, measured
  // within 30 days (offline), or dead (older or never - device_inventory).
  const statusSlices = [
    { key: 'online', label: t('device_stats_status_online'), count: totals.measured_24h, color: plotTheme.contrastGreen },
    {
      key: 'offline',
      label: t('device_stats_status_offline'),
      count: Math.max(0, totals.devices - totals.measured_24h - totals.dead),
      color: plotTheme.contrastYellow,
    },
    { key: 'dead', label: t('device_stats_status_dead'), count: totals.dead, color: RED },
  ];

  const waiting = (
    <div className="d-flex align-items-center gap-2 text-muted py-3">
      <Spinner animation="border" size="sm" />
      {t('ui_loading')}
    </div>
  );

  const renderSection = () => {
    if (!current) {
      // The lists are sorted and capped over all databases - they come once
      // the build is through.
      if (progress) {
        return (
          <div className="d-flex align-items-center gap-2 text-muted py-3" data-testid="device-stats-lists-pending">
            <Spinner animation="border" size="sm" />
            {t('device_stats_lists_after_scan')}
          </div>
        );
      }
      // The overview arrives first; its arrival immediately starts the
      // current tab, so show the spinner instead of a one-frame empty state.
      if (loading || (!error && sections.overview)) {
        return waiting;
      }
      return <div className="small text-muted py-2" data-testid="device-stats-lists-empty">{t('device_stats_empty')}</div>;
    }
    switch (section) {
      case 'by_type':
        return typeGroups.length ? (
          <div className="d-flex flex-column gap-3">
            {typeGroups.map((group) => (
              <div
                key={group.type}
                id={`device-stats-type-${group.type}`}
                className="device-stats-type-group"
                {...repeatedTestId('device-stats-type-group', group.type)}
              >
                <div className="device-stats-section-title">
                  {group.label}{' '}
                  <span className="text-muted">({group.rows.length})</span>
                </div>
                <DeviceList
                  rows={group.rows}
                  selectable
                  showAdminEdit={isSuperuser}
                  selectionKey={`by_type-${group.type}-${selectionEpoch}`}
                  onSelectionChange={selectionHandler(`by_type-${group.type}`, 'device')}
                  testKey={`by-type-${group.type}`}
                />
              </div>
            ))}
          </div>
        ) : (
          <div className="small text-muted py-2" data-testid="device-stats-lists-empty">{t('device_stats_empty')}</div>
        );
      case 'chip_id':
        return (
          <>
            <ListSection title={t('device_stats_with_chip_id')} testKey="chip-with">
              <DeviceList
                rows={current.devices.with_chip_id}
                selectable
                showAdminEdit={isSuperuser}
                selectionKey={`chip-with-${selectionEpoch}`}
                testKey="chip-with"
                onSelectionChange={selectionHandler('chip-with', 'device')}
              />
            </ListSection>
            <ListSection title={t('device_stats_without_chip_id')} testKey="chip-without">
              <DeviceList
                rows={current.devices.without_chip_id}
                selectable
                showAdminEdit={isSuperuser}
                selectionKey={`chip-without-${selectionEpoch}`}
                testKey="chip-without"
                onSelectionChange={selectionHandler('chip-without', 'device')}
              />
            </ListSection>
          </>
        );
      case 'measured':
        return (
          <>
            <ListSection title={t('device_stats_measured_24h')} testKey="measured-yes">
              <DeviceList
                rows={current.devices.measured_24h}
                selectable
                showAdminEdit={isSuperuser}
                selectionKey={`measured-yes-${selectionEpoch}`}
                testKey="measured-yes"
                onSelectionChange={selectionHandler('measured-yes', 'device')}
              />
            </ListSection>
            <ListSection title={t('device_stats_not_measured_24h')} testKey="measured-no">
              <DeviceList
                rows={current.devices.not_measured_24h}
                selectable
                showAdminEdit={isSuperuser}
                selectionKey={`measured-no-${selectionEpoch}`}
                testKey="measured-no"
                onSelectionChange={selectionHandler('measured-no', 'device')}
              />
            </ListSection>
          </>
        );
      case 'lageplan':
        return (
          <ListSection title={t('device_stats_missing_lageplan')} testKey="lageplan">
            <DeviceList
              rows={current.devices.missing_lageplan}
              selectable
              showAdminEdit={isSuperuser}
              selectionKey={`lageplan-${selectionEpoch}`}
              testKey="lageplan"
              onSelectionChange={selectionHandler('lageplan', 'device')}
            />
          </ListSection>
        );
      case 'dead':
        return (
          <ListSection title={t('device_stats_dead_devices')} testKey="dead">
            <DeviceList
              rows={current.devices.dead}
              selectable
              showAdminEdit={isSuperuser}
              selectionKey={`dead-${selectionEpoch}`}
              testKey="dead"
              onSelectionChange={selectionHandler('dead', 'device')}
            />
          </ListSection>
        );
      case 'unused_locations':
        return (
          <ListSection title={t('device_stats_unused_locations')} testKey="unused">
            <LocationList
              rows={current.locations.unused_locations ?? []}
              selectable
              showAdminEdit={isSuperuser}
              selectionKey={`unused-${selectionEpoch}`}
              testKey="unused"
              onSelectionChange={selectionHandler('unused', 'location')}
            />
          </ListSection>
        );
      case 'locations_missing_lageplan':
        return (
          <ListSection title={t('device_stats_locations_missing_lageplan')} testKey="missing-lageplan">
            <LocationList
              rows={current.locations.locations_missing_lageplan ?? []}
              selectable
              showAdminEdit={isSuperuser}
              selectionKey={`missing-lageplan-${selectionEpoch}`}
              testKey="missing-lageplan"
              onSelectionChange={selectionHandler('missing-lageplan', 'location')}
            />
          </ListSection>
        );
      case 'dead_locations':
        return (
          <ListSection title={t('device_stats_dead_locations')} testKey="dead-locations">
            <LocationList
              rows={current.locations.dead_locations ?? []}
              selectable
              showAdminEdit={isSuperuser}
              selectionKey={`dead-locations-${selectionEpoch}`}
              testKey="dead-locations"
              onSelectionChange={selectionHandler('dead-locations', 'location')}
            />
          </ListSection>
        );
      default:
        return null;
    }
  };

  const kpiTiles = [
    {
      label: t('device_stats_kpi_devices'),
      value: hasTotals ? String(totals.devices) : '–',
      note: hasTotals
        ? t('device_stats_kpi_locations_note', { count: totals.locations })
        : undefined,
    },
    {
      label: t('device_stats_with_chip_id'),
      value: hasTotals ? String(totals.with_chip_id) : '–',
      note: hasTotals
        ? t('device_stats_kpi_without_chip_id_note', {
            count: totals.without_chip_id,
          })
        : undefined,
    },
    {
      label: t('device_stats_measured_24h'),
      value: hasTotals ? String(totals.measured_24h) : '–',
      note: hasTotals
        ? t('device_stats_kpi_not_measured_24h_note', {
            count: totals.not_measured_24h,
          })
        : undefined,
    },
    {
      label: t('device_stats_missing_lageplan'),
      value: hasTotals ? String(totals.missing_lageplan) : '–',
    },
    {
      label: t('device_stats_dead_devices'),
      value: hasTotals ? String(totals.dead) : '–',
      valueColor: totals.dead > 0 ? RED : undefined,
    },
    {
      label: t('device_stats_unused_locations'),
      value: hasTotals ? String(totals.unused_locations) : '–',
      valueColor: totals.unused_locations > 0 ? AMBER : undefined,
    },
    {
      label: t('device_stats_locations_missing_lageplan'),
      value: hasTotals ? String(totals.locations_missing_lageplan) : '–',
    },
  ];

  return (
    <div className="device-stats" data-testid="page-device-statistics">
      {header}

      <KpiStrip tiles={kpiTiles} testId="device-stats-kpis" />

      <div className="device-stats-grid">
        <PanelCard title={t('device_stats_by_type_title')} testId="device-stats-by-type">
          {!hasCounts ? (
            loading ? waiting : <div className="small text-muted py-2" data-testid="device-stats-type-chart-empty">{t('device_stats_empty')}</div>
          ) : (
            <DonutChart
              slices={typeSlices}
              centerLabel={t('device_stats_kpi_devices')}
              ariaLabel={t('device_stats_by_type_title')}
              onSelect={openTypeTable}
              selectTitle={t('device_stats_type_open')}
              testId="device-stats-type-chart"
            />
          )}
        </PanelCard>
        <PanelCard title={t('device_stats_status_title')} testId="device-stats-status">
          {!hasCounts ? (
            loading ? waiting : <div className="small text-muted py-2" data-testid="device-stats-status-chart-empty">{t('device_stats_empty')}</div>
          ) : (
            <DonutChart
              slices={statusSlices}
              centerLabel={t('device_stats_kpi_devices')}
              ariaLabel={t('device_stats_status_title')}
              // Online/offline: the 24 h lists, dead: the dead devices.
              onSelect={(key) => chooseSection(key === 'dead' ? 'dead' : 'measured')}
              selectTitle={t('device_stats_status_open')}
              testId="device-stats-status-chart"
            />
          )}
        </PanelCard>
      </div>

      <PanelCard
        testId="device-stats-lists"
        title={t('device_stats_lists_title')}
        actions={
          <SegmentedControl
            options={sectionOptions}
            value={section}
            onChange={(value) => chooseSection(value as StatsSection)}
            disabled={loading || deleting}
            testId="device-stats-section"
          />
        }
      >
        {renderSection()}
      </PanelCard>

      <ConfirmDialog
        show={confirmDelete}
        title={t('device_stats_delete_title')}
        message={t('device_stats_delete_message', {
          devices: selectedDevices.length,
          locations: selectedLocations.length,
        })}
        confirmLabel={t('device_stats_delete_confirm')}
        cancelLabel={t('heat_limit_cancel')}
        onConfirm={performDelete}
        onCancel={() => setConfirmDelete(false)}
        confirming={deleting}
        testId="device-stats-delete-confirm"
      />
    </div>
  );
};

export default DeviceStatisticsView;