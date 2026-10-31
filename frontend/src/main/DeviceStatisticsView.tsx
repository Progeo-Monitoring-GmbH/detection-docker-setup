import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Alert, Badge, Spinner, Table } from 'react-bootstrap';
import { ArrowRepeat } from 'react-bootstrap-icons';
import DataTable, { type TableColumn } from 'react-data-table-component';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../hooks/CoreAuthProvider';
import axiosConfig from '../axiosConfig';
import KpiStrip from '../components/ui/kit/KpiStrip';
import PanelCard from '../components/ui/kit/PanelCard';
import PillButton from '../components/ui/kit/PillButton';
import SegmentedControl from '../components/ui/kit/SegmentedControl';
import { errorReason } from '../components/ui/Snackbar.jsx';
import { formatDate } from './dateFormat';

/** A row of GET /v1/status/device_statistics/ - devices.* and by_type values. */
type StatisticsDevice = {
  id: number;
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

type DeviceStatistics = {
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
  locations: {
    unused: StatisticsLocation[];
    missing_lageplan: StatisticsLocation[];
    dead: StatisticsLocation[];
  };
};

type StatsSection =
  | 'by_type'
  | 'chip_id'
  | 'measured'
  | 'lageplan'
  | 'dead'
  | 'unused_locations'
  | 'locations_missing_lageplan'
  | 'dead_locations';

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
const normalizeStatistics = (raw: unknown): DeviceStatistics => {
  const data = (raw || {}) as Partial<DeviceStatistics>;
  const devices = (data.devices ?? {}) as Partial<DeviceStatistics['devices']>;
  const locations = (data.locations ?? {}) as Partial<
    DeviceStatistics['locations']
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
    locations: {
      unused: locations.unused ?? [],
      missing_lageplan: locations.missing_lageplan ?? [],
      dead: locations.dead ?? [],
    },
  };
};

const RED = '#B42318';
const AMBER = '#B54708';
const MUTED = '#8B8383';

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

/** The shared device table (device, type, chip id, location, last measurement). */
const DeviceList = ({ rows }: { rows: StatisticsDevice[] }) => {
  const { t } = useTranslation();

  if (!rows.length) {
    return <div className="small text-muted py-2">{t('device_stats_empty')}</div>;
  }

  const columns: TableColumn<StatisticsDevice>[] = [
    {
      name: t('device_stats_col_device'),
      selector: (row) => row.display_name || row.raw_hash,
      cell: (row) => (
        <div className="small">
          <div>{row.display_name || row.raw_hash}</div>
          <code className="text-muted">{row.raw_hash}</code>
        </div>
      ),
      minWidth: '190px',
      wrap: true,
    },
    {
      name: t('device_stats_col_type'),
      selector: (row) => row.type ?? '',
      cell: (row) => (
        <div className="small">
          {row.type || t('devices_type_unset')}
          {row.hardware && <div className="text-muted">{row.hardware}</div>}
        </div>
      ),
      width: '150px',
      wrap: true,
    },
    {
      name: t('device_stats_col_chip_id'),
      selector: (row) => row.chip_id ?? '',
      cell: (row) =>
        row.chip_id ? (
          <code className="small">{row.chip_id}</code>
        ) : (
          <span style={{ color: MUTED }}>–</span>
        ),
      width: '145px',
    },
    {
      name: t('device_stats_col_location'),
      selector: (row) => row.location_name ?? '',
      cell: (row) => (
        <div className="small">
          <div>{row.location_name || '–'}</div>
          {row.project_id != null && (
            <div className="text-muted">#{row.project_id}</div>
          )}
        </div>
      ),
      minWidth: '160px',
      wrap: true,
    },
    {
      name: t('device_stats_col_last_measurement'),
      selector: (row) => row.last_measurement_at ?? '',
      cell: (row) => (
        <span className="small">
          {formatDate(row.last_measurement_at, 'dateTime')}
        </span>
      ),
      width: '155px',
    },
  ];

  return (
    <DataTable
      columns={columns}
      data={rows}
      pagination
      paginationPerPage={15}
      paginationRowsPerPageOptions={[10, 15, 25, 50, 100]}
    />
  );
};

/** The shared location table (location, device count, Lageplan, status). */
const LocationList = ({ rows }: { rows: StatisticsLocation[] }) => {
  const { t } = useTranslation();

  if (!rows.length) {
    return <div className="small text-muted py-2">{t('device_stats_empty')}</div>;
  }

  const columns: TableColumn<StatisticsLocation>[] = [
    {
      name: t('device_stats_col_location'),
      selector: (row) => row.name ?? '',
      cell: (row) => (
        <div className="small">
          <div>{row.name || '–'}</div>
          {row.project_id != null && (
            <div className="text-muted">#{row.project_id}</div>
          )}
        </div>
      ),
      minWidth: '190px',
      wrap: true,
    },
    {
      name: t('device_stats_col_devices'),
      selector: (row) => row.device_count,
      cell: (row) => <span className="small">{row.device_count}</span>,
      width: '100px',
    },
    {
      name: t('device_stats_col_last_measurement'),
      selector: (row) => row.last_measurement_at ?? '',
      cell: (row) => (
        <span className="small">
          {formatDate(row.last_measurement_at, 'dateTime')}
        </span>
      ),
      width: '155px',
    },
    {
      name: t('device_stats_col_lageplan'),
      selector: (row) => (row.has_lageplan ? 1 : 0),
      cell: (row) => (
        <Badge bg={row.has_lageplan ? 'success' : 'secondary'}>
          {row.has_lageplan ? t('device_stats_yes') : t('device_stats_no')}
        </Badge>
      ),
      width: '110px',
    },
    {
      name: t('device_stats_col_status'),
      selector: (row) => `${row.unused ? 'unused' : ''} ${row.dead ? 'dead' : ''}`,
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
      width: '150px',
    },
  ];

  return (
    <DataTable
      columns={columns}
      data={rows}
      pagination
      paginationPerPage={15}
      paginationRowsPerPageOptions={[10, 15, 25, 50, 100]}
    />
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

  const [stats, setStats] = useState<DeviceStatistics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [section, setSection] = useState<StatsSection>('by_type');

  const load = useCallback(() => {
    if (!isStaff) {
      return;
    }
    setLoading(true);
    setError(null);
    void axiosConfig.perform_get(
      auth,
      '/v1/status/device_statistics/',
      (response) => {
        setStats(normalizeStatistics(response?.data));
        setLoading(false);
      },
      (requestError) => {
        setStats(null);
        setError(errorReason(requestError) || 'Unknown error');
        setLoading(false);
      },
    );
    // Once per auth state - auth changes with the path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStaff]);

  useEffect(load, [load]);

  if (!isStaff) {
    return (
      <div className="text-muted py-5 text-center">
        {t('device_stats_staff_only')}
      </div>
    );
  }

  const header = (
    <PanelCard
      title={t('device_stats_title')}
      actions={
        <div className="d-flex align-items-center gap-2 flex-wrap">
          {stats?.generated_at && (
            <span className="small text-muted">
              {t('device_stats_generated_at', {
                date: formatDate(stats.generated_at, 'dateTime'),
              })}
            </span>
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
            onClick={load}
            disabled={loading}
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

  if (!stats) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {header}
        <PanelCard>
          {loading ? (
            <div className="d-flex justify-content-center py-5 text-muted">
              <Spinner animation="border" className="me-2" />
              {t('ui_loading')}
            </div>
          ) : (
            <div className="small text-muted py-2">{t('device_stats_empty')}</div>
          )}
        </PanelCard>
      </div>
    );
  }

  const { totals } = stats;
  // The label of a type as the backend resolved it ("unset" included).
  const typeLabel = (type: string) =>
    stats.by_type.find((row) => row.type === type)?.label ||
    (type === 'unset' ? t('devices_type_unset') : type);
  const typeGroups = stats.by_type
    .map((row) => ({
      type: row.type,
      label: row.label || typeLabel(row.type),
      rows: stats.devices.by_type[row.type] ?? [],
    }))
    .filter((group) => group.rows.length > 0);

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

  const renderSection = () => {
    switch (section) {
      case 'by_type':
        return typeGroups.length ? (
          <div className="d-flex flex-column gap-3">
            {typeGroups.map((group) => (
              <div key={group.type}>
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
                <DeviceList rows={group.rows} />
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
              <DeviceList rows={stats.devices.with_chip_id} />
            </ListSection>
            <ListSection title={t('device_stats_without_chip_id')}>
              <DeviceList rows={stats.devices.without_chip_id} />
            </ListSection>
          </>
        );
      case 'measured':
        return (
          <>
            <ListSection title={t('device_stats_measured_24h')}>
              <DeviceList rows={stats.devices.measured_24h} />
            </ListSection>
            <ListSection title={t('device_stats_not_measured_24h')}>
              <DeviceList rows={stats.devices.not_measured_24h} />
            </ListSection>
          </>
        );
      case 'lageplan':
        return (
          <ListSection title={t('device_stats_missing_lageplan')}>
            <DeviceList rows={stats.devices.missing_lageplan} />
          </ListSection>
        );
      case 'dead':
        return (
          <ListSection title={t('device_stats_dead_devices')}>
            <DeviceList rows={stats.devices.dead} />
          </ListSection>
        );
      case 'unused_locations':
        return (
          <ListSection title={t('device_stats_unused_locations')}>
            <LocationList rows={stats.locations.unused} />
          </ListSection>
        );
      case 'locations_missing_lageplan':
        return (
          <ListSection title={t('device_stats_locations_missing_lageplan')}>
            <LocationList rows={stats.locations.missing_lageplan} />
          </ListSection>
        );
      case 'dead_locations':
        return (
          <ListSection title={t('device_stats_dead_locations')}>
            <LocationList rows={stats.locations.dead} />
          </ListSection>
        );
      default:
        return null;
    }
  };

  const kpiTiles = [
    {
      label: t('device_stats_kpi_devices'),
      value: String(totals.devices),
      note: t('device_stats_kpi_locations_note', { count: totals.locations }),
    },
    {
      label: t('device_stats_with_chip_id'),
      value: String(totals.with_chip_id),
      note: t('device_stats_kpi_without_chip_id_note', {
        count: totals.without_chip_id,
      }),
    },
    {
      label: t('device_stats_measured_24h'),
      value: String(totals.measured_24h),
      note: t('device_stats_kpi_not_measured_24h_note', {
        count: totals.not_measured_24h,
      }),
    },
    {
      label: t('device_stats_missing_lageplan'),
      value: String(totals.missing_lageplan),
    },
    {
      label: t('device_stats_dead_devices'),
      value: String(totals.dead),
      valueColor: totals.dead > 0 ? RED : undefined,
    },
    {
      label: t('device_stats_unused_locations'),
      value: String(totals.unused_locations),
      valueColor: totals.unused_locations > 0 ? AMBER : undefined,
    },
    {
      label: t('device_stats_locations_missing_lageplan'),
      value: String(totals.locations_missing_lageplan),
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {header}

      <KpiStrip tiles={kpiTiles} />

      <PanelCard title={t('device_stats_by_type_title')}>
        {stats.by_type.length === 0 ? (
          <div className="small text-muted py-2">{t('device_stats_empty')}</div>
        ) : (
          <Table responsive size="sm" className="align-middle mb-0">
            <thead>
              <tr>
                <th>{t('device_stats_col_type')}</th>
                <th className="text-end">{t('device_stats_col_count')}</th>
              </tr>
            </thead>
            <tbody>
              {stats.by_type.map((row) => (
                <tr key={row.type}>
                  <td>{row.label || typeLabel(row.type)}</td>
                  <td className="text-end">{row.count}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </PanelCard>

      <PanelCard
        title={t('device_stats_lists_title')}
        actions={
          <SegmentedControl
            options={sectionOptions}
            value={section}
            onChange={(value) => setSection(value as StatsSection)}
          />
        }
      >
        {renderSection()}
      </PanelCard>
    </div>
  );
};

export default DeviceStatisticsView;
