import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Alert, Badge, Button, Spinner } from 'react-bootstrap';
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
import { formatDate } from './dateFormat';
import { plotTheme } from '../styles/plotTheme';

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

/** The API section a tab needs; the by-type tab doubles as the overview. */
const REQUEST_SECTION: Record<StatsSection, StatisticsRequestSection> = {
  by_type: 'overview',
  chip_id: 'chip_id',
  measured: 'measured',
  lageplan: 'lageplan',
  dead: 'dead',
  unused_locations: 'unused_locations',
  locations_missing_lageplan: 'locations_missing_lageplan',
  dead_locations: 'dead_locations',
};

const RED = '#B42318';
const AMBER = '#B54708';
const MUTED = '#8B8383';

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
}: {
  title: string;
  children: ReactNode;
}) => (
  <div className="mb-3">
    <div
      style={{
        fontSize: 13.5,
        fontWeight: 600,
        color: 'var(--progeo-blue)',
        marginBottom: 6,
      }}
    >
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

const deviceDetailUrl = (row: StatisticsDevice) =>
  `/device/${row.id}/detail${row.location_id != null ? `?location=${row.location_id}` : ''}`;

const locationDetailUrl = (row: Pick<StatisticsLocation, 'id'>) =>
  `/location/${row.id}/status`;

/** The shared device table (device, type, chip id, location, last measurement). */
const DeviceList = ({
  rows,
  selectable = false,
  selectionKey,
  onSelectionChange,
  showAdminEdit = false,
}: {
  rows: StatisticsDevice[];
  selectable?: boolean;
  selectionKey?: string;
  onSelectionChange?: (rows: StatisticsDevice[]) => void;
  showAdminEdit?: boolean;
}) => {
  const { t } = useTranslation();

  if (!rows.length) {
    return <div className="small text-muted py-2">{t('device_stats_empty')}</div>;
  }

  const columns: TableColumn<StatisticsDevice>[] = [
    {
      name: t('device_stats_col_device'),
      selector: (row) => row.display_name || row.raw_hash,
      sortable: true,
      cell: (row) => (
        <div className="small">
          <Link to={deviceDetailUrl(row)} title={t('device_stats_open_device')}>
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
          <span style={{ color: MUTED }}>–</span>
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
        <span className="small">
          {formatDate(row.last_measurement_at, 'dateTime')}
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
}: {
  rows: StatisticsLocation[];
  selectable?: boolean;
  selectionKey?: string;
  onSelectionChange?: (rows: StatisticsLocation[]) => void;
  showAdminEdit?: boolean;
}) => {
  const { t } = useTranslation();

  if (!rows.length) {
    return <div className="small text-muted py-2">{t('device_stats_empty')}</div>;
  }

  const columns: TableColumn<StatisticsLocation>[] = [
    {
      name: t('device_stats_col_location'),
      selector: (row) => row.name ?? '',
      sortable: true,
      cell: (row) => (
        <div className="small">
          <Link to={locationDetailUrl(row)} title={t('device_stats_open_location')}>
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
        <span className="small">
          {formatDate(row.last_measurement_at, 'dateTime')}
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
            <span style={{ color: MUTED }}>–</span>
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
const TYPE_PIE_COLORS = [
  plotTheme.brandBlue,
  plotTheme.brandOrange,
  plotTheme.contrastGreen,
  plotTheme.contrastViolet,
  plotTheme.contrastCyan,
  plotTheme.contrastYellow,
  '#6b6b6b',
];

/** Device types as a clickable donut - each slice/legend entry opens its table. */
const TypePieChart = ({
  rows,
  onSelect,
}: {
  rows: StatisticsTypeRow[];
  onSelect: (type: string) => void;
}) => {
  const { t } = useTranslation();
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  if (!rows.length || total <= 0) {
    return <div className="small text-muted py-2">{t('device_stats_empty')}</div>;
  }

  const center = 100;
  const radius = 78;
  let angle = -Math.PI / 2;
  const segments = rows.map((row, index) => {
    const start = angle;
    const sweep = (row.count / total) * Math.PI * 2;
    angle += sweep;
    const end = angle;
    const point = (value: number) =>
      [
        center + radius * Math.cos(value),
        center + radius * Math.sin(value),
      ] as const;
    const [x1, y1] = point(start);
    const [x2, y2] = point(end);
    return {
      row,
      color: TYPE_PIE_COLORS[index % TYPE_PIE_COLORS.length],
      percent: Math.round((row.count / total) * 100),
      // A single type is a full circle; otherwise a pie slice per type.
      path:
        rows.length === 1
          ? null
          : `M ${center} ${center} L ${x1} ${y1} A ${radius} ${radius} 0 ${
              sweep > Math.PI ? 1 : 0
            } 1 ${x2} ${y2} Z`,
    };
  });

  return (
    <div className="d-flex flex-wrap align-items-center gap-4">
      <svg
        width={210}
        height={210}
        viewBox="0 0 200 200"
        role="img"
        aria-label={t('device_stats_by_type_title')}
        style={{ flexShrink: 0 }}
      >
        {segments.map((segment) =>
          segment.path ? (
            <path
              key={segment.row.type}
              d={segment.path}
              fill={segment.color}
              stroke="var(--progeo-panel-bg)"
              strokeWidth={1.5}
              style={{ cursor: 'pointer' }}
              onClick={() => onSelect(segment.row.type)}
            >
              <title>
                {segment.row.label}: {segment.row.count} · {segment.percent}%
              </title>
            </path>
          ) : (
            <circle
              key={segment.row.type}
              cx={center}
              cy={center}
              r={radius}
              fill={segment.color}
              style={{ cursor: 'pointer' }}
              onClick={() => onSelect(segment.row.type)}
            >
              <title>
                {segment.row.label}: {segment.row.count} · {segment.percent}%
              </title>
            </circle>
          ),
        )}
        <circle
          cx={center}
          cy={center}
          r={46}
          fill="var(--progeo-panel-bg)"
          pointerEvents="none"
        />
        <text
          x={center}
          y={center - 2}
          textAnchor="middle"
          style={{
            fontSize: 24,
            fontWeight: 600,
            fill: 'var(--progeo-blue)',
          }}
        >
          {total}
        </text>
        <text
          x={center}
          y={center + 16}
          textAnchor="middle"
          style={{ fontSize: 10, fill: MUTED }}
        >
          {t('device_stats_kpi_devices')}
        </text>
      </svg>
      <div
        className="d-flex flex-column gap-1"
        style={{ minWidth: 210, flex: '1 1 210px' }}
      >
        {segments.map((segment) => (
          <button
            key={segment.row.type}
            type="button"
            onClick={() => onSelect(segment.row.type)}
            title={t('device_stats_type_open')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              width: '100%',
              padding: '3px 4px',
              border: 'none',
              borderRadius: 6,
              background: 'transparent',
              color: 'var(--progeo-blue)',
              fontFamily: 'inherit',
              fontSize: 12.5,
              textAlign: 'left',
              cursor: 'pointer',
            }}
          >
            <span
              style={{
                width: 9,
                height: 9,
                borderRadius: 2,
                background: segment.color,
                flexShrink: 0,
              }}
            />
            <span>{segment.row.label}</span>
            <span className="ms-auto text-muted">
              {segment.row.count} · {segment.percent}%
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
  const user = auth?.user as
    | { is_staff?: boolean; is_superuser?: boolean }
    | null
    | undefined;
  const isStaff = Boolean(user?.is_staff || user?.is_superuser);
  const isSuperuser = Boolean(user?.is_superuser);
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

  const loadSection = useCallback(
    (key: StatisticsRequestSection, refresh = false) => {
      if (!isStaff || inFlight.current) {
        return;
      }
      inFlight.current = true;
      const request = ++requestRef.current;
      setLoading(true);
      setError(null);
      void axiosConfig.perform_get(
        authRef.current,
        `/v1/status/device_statistics/?section=${key}${refresh ? '&refresh=1' : ''}`,
        (response) => {
          if (request !== requestRef.current) {
            return;
          }
          const data = normalizeSection(response?.data);
          setSections((current) => ({ ...current, [key]: data }));
          inFlight.current = false;
          setLoading(false);
        },
        (requestError) => {
          if (request !== requestRef.current) {
            return;
          }
          setError(errorReason(requestError) || 'Unknown error');
          inFlight.current = false;
          setLoading(false);
        },
      );
    },
    [isStaff],
  );

  useEffect(() => {
    if (!isStaff) {
      return;
    }
    // The shell is already on screen; this is the first (warming) section.
    loadSection('overview');
    // Once per staff state / auth context.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStaff, loadSection]);

  const requestKey = REQUEST_SECTION[section];
  const hasCurrent = Boolean(sections[requestKey]);

  // Every tab request waits until the overview (which warms the server cache)
  // is there, so switching tabs early cannot start two expensive scans.
  useEffect(() => {
    if (!isStaff || !sections.overview || hasCurrent) {
      return;
    }
    loadSection(requestKey);
    // Runs when the overview arrives or the tab changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStaff, sections.overview, hasCurrent, requestKey, loadSection]);

  useEffect(() => {
    if (!isStaff || !scrollToType || section !== 'by_type' || !sections.overview) {
      return;
    }
    document
      .getElementById(`device-stats-type-${scrollToType}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setScrollToType(null);
    // Scroll once, when the target table is actually rendered.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStaff, scrollToType, section, sections.overview]);

  if (!isStaff) {
    return (
      <div className="text-muted py-5 text-center">
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
    // The overview rebuilds (and re-caches) the full snapshot; the tab effect
    // then fetches the current section from that fresh cache.
    clearSelection();
    setSections({});
    loadSection('overview', true);
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
        loadSection('overview', true);
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
  const totals = current?.totals ?? overview?.totals ?? EMPTY_TOTALS;
  const hasTotals = current != null || overview != null;
  const generatedAt = current?.generated_at ?? overview?.generated_at ?? null;
  const typeRows = overview?.by_type ?? [];

  const header = (
    <PanelCard
      title={t('device_stats_title')}
      actions={
        <div className="d-flex align-items-center gap-2 flex-wrap">
          {generatedAt && (
            <span className="small text-muted">
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
          />
        </div>
      }
    >
      <div className="small" style={{ color: MUTED }}>
        {t('device_stats_hint')}
      </div>
      {error && (
        <Alert variant="danger" className="mt-2 mb-0">
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

  const typeLabel = (type: string) =>
    typeRows.find((row) => row.type === type)?.label ||
    (type === 'unset' ? t('devices_type_unset') : type);

  const typeGroups = typeRows
    .map((row) => ({
      type: row.type,
      label: row.label || typeLabel(row.type),
      rows: overview?.devices.by_type[row.type] ?? [],
    }))
    .filter((group) => group.rows.length > 0);

  const waiting = (
    <div className="d-flex align-items-center gap-2 text-muted py-3">
      <Spinner animation="border" size="sm" />
      {t('ui_loading')}
    </div>
  );

  const renderSection = () => {
    if (!current) {
      // The overview warms the cache; its arrival immediately starts the
      // current tab, so show the spinner instead of a one-frame empty state.
      if (loading || (!error && sections.overview)) {
        return waiting;
      }
      return <div className="small text-muted py-2">{t('device_stats_empty')}</div>;
    }
    switch (section) {
      case 'by_type':
        return typeGroups.length ? (
          <div className="d-flex flex-column gap-3">
            {typeGroups.map((group) => (
              <div
                key={group.type}
                id={`device-stats-type-${group.type}`}
                style={{ scrollMarginTop: 16 }}
              >
                <div
                  style={{
                    fontSize: 13.5,
                    fontWeight: 600,
                    color: 'var(--progeo-blue)',
                    marginBottom: 6,
                  }}
                >
                  {group.label}{' '}
                  <span className="text-muted">({group.rows.length})</span>
                </div>
                <DeviceList
                  rows={group.rows}
                  selectable
                  showAdminEdit={isSuperuser}
                  selectionKey={`by_type-${group.type}-${selectionEpoch}`}
                  onSelectionChange={selectionHandler(`by_type-${group.type}`, 'device')}
                />
              </div>
            ))}
          </div>
        ) : (
          <div className="small text-muted py-2">{t('device_stats_empty')}</div>
        );
      case 'chip_id':
        return (
          <>
            <ListSection title={t('device_stats_with_chip_id')}>
              <DeviceList
                rows={current.devices.with_chip_id}
                selectable
                showAdminEdit={isSuperuser}
                selectionKey={`chip-with-${selectionEpoch}`}
                onSelectionChange={selectionHandler('chip-with', 'device')}
              />
            </ListSection>
            <ListSection title={t('device_stats_without_chip_id')}>
              <DeviceList
                rows={current.devices.without_chip_id}
                selectable
                showAdminEdit={isSuperuser}
                selectionKey={`chip-without-${selectionEpoch}`}
                onSelectionChange={selectionHandler('chip-without', 'device')}
              />
            </ListSection>
          </>
        );
      case 'measured':
        return (
          <>
            <ListSection title={t('device_stats_measured_24h')}>
              <DeviceList
                rows={current.devices.measured_24h}
                selectable
                showAdminEdit={isSuperuser}
                selectionKey={`measured-yes-${selectionEpoch}`}
                onSelectionChange={selectionHandler('measured-yes', 'device')}
              />
            </ListSection>
            <ListSection title={t('device_stats_not_measured_24h')}>
              <DeviceList
                rows={current.devices.not_measured_24h}
                selectable
                showAdminEdit={isSuperuser}
                selectionKey={`measured-no-${selectionEpoch}`}
                onSelectionChange={selectionHandler('measured-no', 'device')}
              />
            </ListSection>
          </>
        );
      case 'lageplan':
        return (
          <ListSection title={t('device_stats_missing_lageplan')}>
            <DeviceList
              rows={current.devices.missing_lageplan}
              selectable
              showAdminEdit={isSuperuser}
              selectionKey={`lageplan-${selectionEpoch}`}
              onSelectionChange={selectionHandler('lageplan', 'device')}
            />
          </ListSection>
        );
      case 'dead':
        return (
          <ListSection title={t('device_stats_dead_devices')}>
            <DeviceList
              rows={current.devices.dead}
              selectable
              showAdminEdit={isSuperuser}
              selectionKey={`dead-${selectionEpoch}`}
              onSelectionChange={selectionHandler('dead', 'device')}
            />
          </ListSection>
        );
      case 'unused_locations':
        return (
          <ListSection title={t('device_stats_unused_locations')}>
            <LocationList
              rows={current.locations.unused_locations ?? []}
              selectable
              showAdminEdit={isSuperuser}
              selectionKey={`unused-${selectionEpoch}`}
              onSelectionChange={selectionHandler('unused', 'location')}
            />
          </ListSection>
        );
      case 'locations_missing_lageplan':
        return (
          <ListSection title={t('device_stats_locations_missing_lageplan')}>
            <LocationList
              rows={current.locations.locations_missing_lageplan ?? []}
              selectable
              showAdminEdit={isSuperuser}
              selectionKey={`missing-lageplan-${selectionEpoch}`}
              onSelectionChange={selectionHandler('missing-lageplan', 'location')}
            />
          </ListSection>
        );
      case 'dead_locations':
        return (
          <ListSection title={t('device_stats_dead_locations')}>
            <LocationList
              rows={current.locations.dead_locations ?? []}
              selectable
              showAdminEdit={isSuperuser}
              selectionKey={`dead-locations-${selectionEpoch}`}
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {header}

      <KpiStrip tiles={kpiTiles} />

      <PanelCard title={t('device_stats_by_type_title')}>
        {!overview ? (
          loading ? waiting : <div className="small text-muted py-2">{t('device_stats_empty')}</div>
        ) : typeRows.length === 0 ? (
          <div className="small text-muted py-2">{t('device_stats_empty')}</div>
        ) : (
          <TypePieChart rows={typeRows} onSelect={openTypeTable} />
        )}
      </PanelCard>

      <PanelCard
        title={t('device_stats_lists_title')}
        actions={
          <SegmentedControl
            options={sectionOptions}
            value={section}
            onChange={(value) => chooseSection(value as StatsSection)}
            disabled={loading || deleting}
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
      />
    </div>
  );
};

export default DeviceStatisticsView;