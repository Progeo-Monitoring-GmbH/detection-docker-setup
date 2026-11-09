import { type CSSProperties, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useSnackbar } from 'notistack';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router';
import {
  Activity,
  ArrowClockwise,
  ArrowRepeat,
  Broadcast,
  Image,
  PlusCircle,
  Sliders,
  Terminal,
} from 'react-bootstrap-icons';
import { Spinner } from 'react-bootstrap';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import usePermissions from '../../hooks/usePermissions';
import axiosConfig from '../axiosConfig';
import { formatDate } from './dateFormat';
import { showRequestError, showSuccessBar } from '../components/ui/Snackbar.jsx';
import LocationPicker, { type PickableLocation } from '../components/location/LocationPicker';
import DeviceCommandsDialog from '../components/device/DeviceCommandsDialog';
import AirtableSyncPanel, { type AirtableSync } from '../components/device/AirtableSyncPanel';
import DeviceProvisionPanel, { type ProvisionedDevice } from '../components/device/DeviceProvisionPanel';
import ProvisionTestMeasurements from '../components/device/ProvisionTestMeasurements';
import ConfirmDialog from '../components/ui/kit/ConfirmDialog';
import DeleteIconButton from '../components/ui/kit/DeleteIconButton';
import KpiStrip from '../components/ui/kit/KpiStrip';
import PanelCard from '../components/ui/kit/PanelCard';
import PillButton from '../components/ui/kit/PillButton';
import SearchableDataTable, { type SearchableColumn } from '../components/ui/kit/SearchableDataTable';
import SegmentedControl from '../components/ui/kit/SegmentedControl';
import { staffFlags } from './access';

type HashKind = 'project' | 'mac' | 'legacy';

/** A row of /v1/status/location_devices/ (DeviceSerializer + overview fields). */
type OverviewDevice = {
  id: number;
  location: number | null;
  raw_hash: string;
  display_name?: string;
  /** Technical class (smartbox, node, lorawan, ...). */
  type?: string | null;
  /** The precise model ("smartex dm") - null if hardware names no known one. */
  model: string | null;
  hardware?: string | null;
  version?: string | null;
  mac?: string | null;
  data_interval?: number;
  last_measurement_at: string | null;
  last_seen_at: string | null;
  online: boolean;
  hash_kind: HashKind;
  ip: string | null;
  /** null: not pinged, or no private IPv4 to ping. */
  ping: boolean | null;
};

type OverviewStats = {
  total: number;
  online: number;
  offline: number;
  never_seen: number;
  hash_kinds: Record<HashKind, number>;
  ping: { reachable: number; unreachable: number; no_ip: number } | null;
};

type Overview = {
  location: { id: number; project_id: number | null; name: string | null };
  devices: OverviewDevice[];
  stats: OverviewStats;
  pinged: boolean;
};

type Filter = 'all' | 'online' | 'offline' | 'project';

const MUTED = '#8B8383';
const GREEN = '#3F7A1C';
const RED = '#C44D26';

const HASH_KINDS: HashKind[] = ['project', 'mac', 'legacy'];

const Chip = ({
  children,
  color = '#6E6868',
  background = 'var(--progeo-track-soft)',
  title,
}: {
  children: ReactNode;
  color?: string;
  background?: string;
  title?: string;
}) => (
  <span
    title={title}
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      fontSize: 11.5,
      fontWeight: 600,
      color,
      background,
      borderRadius: 'var(--progeo-radius-pill)',
      padding: '3px 10px',
      whiteSpace: 'nowrap',
    }}
  >
    {children}
  </span>
);

const Dot = ({ color }: { color: string }) => (
  <span style={{ width: 7, height: 7, borderRadius: '50%', background: color, flexShrink: 0 }} />
);

/** One count with a bar relative to the location's device total. */
const CountBar = ({ label, count, total, hint }: { label: string; count: number; total: number; hint?: string }) => (
  <div title={hint}>
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, marginBottom: 4 }}>
      <span style={{ color: count ? 'var(--progeo-blue)' : MUTED }}>{label}</span>
      <span style={{ fontWeight: 600, color: count ? 'var(--progeo-blue)' : MUTED }}>{count}</span>
    </div>
    <div style={{ height: 6, borderRadius: 3, background: 'var(--progeo-track)', overflow: 'hidden' }}>
      <div
        style={{
          width: total ? `${(count / total) * 100}%` : 0,
          height: '100%',
          borderRadius: 3,
          background: 'var(--progeo-blue)',
        }}
      />
    </div>
  </div>
);

const actionStyle = (disabled = false): CSSProperties => ({
  width: 30,
  height: 30,
  border: 'none',
  borderRadius: 9,
  background: 'var(--progeo-surface)',
  boxShadow: '0 2px 8px rgba(11, 54, 89, .12)',
  color: 'var(--progeo-blue)',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: disabled ? 'default' : 'pointer',
  opacity: disabled ? 0.4 : 1,
  padding: 0,
});

const muted = <span style={{ color: MUTED }}>–</span>;

/**
 * Device overview of ONE location: pick it with the LocationPicker, then
 * only its devices are loaded (/v1/status/location_devices/) - instead of
 * every device of every project database at once (/v1/status/devices/).
 * KPIs and breakdowns come with the list; staff also get the devices
 * pinged (a second request, so the list shows without waiting for it).
 * The picked location is kept in ?location= (bookmarkable).
 *
 * Also the device setup (formerly /device/provision/, staff or
 * module_devices_provision): "Gerät hinzufügen" provisions a new controller
 * for the location (DeviceProvisionPanel), each device's "Test-Messungen"
 * follow its test measurements, staff can sync the locations with Airtable.
 */
const DeviceListView = () => {
  const auth = useAuth();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { enqueueSnackbar } = useSnackbar();
  const { hasPermission } = usePermissions();
  const [searchParams, setSearchParams] = useSearchParams();
  // Ping is a staff tool (is_staff_admin in the backend).
  const isStaff = staffFlags(auth?.user).isStaffOrSuperuser;
  // Controller commands: staff or module_devices_commands (also queueing them).
  const canCommands = isStaff || hasPermission('module_devices_commands');
  // update (writes a whole file) and command results (the config) are superuser-only.
  const isSuperuser = staffFlags(auth?.user).isSuperuser;
  const canEdit = hasPermission('module_devices_edit');
  const canDelete = hasPermission('module_devices_delete');
  // Device setup: staff always, like the backend's require_module_permissions.
  const canProvision = isStaff || hasPermission('module_devices_provision');
  // The list (location_devices) needs module_devices_enabled - a user with
  // only the setup permission gets the setup alone.
  const canList = isStaff || hasPermission('module_devices_enabled');

  const [locations, setLocations] = useState<PickableLocation[]>([]);
  const [locationsLoading, setLocationsLoading] = useState(true);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(false);
  const [pinging, setPinging] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [deleteTarget, setDeleteTarget] = useState<OverviewDevice | null>(null);
  const [deleting, setDeleting] = useState(false);
  // Controller commands (sample/cc) of this device - staff only.
  const [commandsTarget, setCommandsTarget] = useState<OverviewDevice | null>(null);
  // "Gerät hinzufügen" is open.
  const [adding, setAdding] = useState(false);
  // The device whose test measurements are shown (new or picked in the list).
  const [testDevice, setTestDevice] = useState<ProvisionedDevice | null>(null);
  const [airtable, setAirtable] = useState<AirtableSync | null>(null);
  const [syncing, setSyncing] = useState(false);
  // Answers of an older selection are dropped.
  const requestRef = useRef(0);

  const locationParam = Number(searchParams.get('location'));
  const locationId = Number.isInteger(locationParam) && locationParam > 0 ? locationParam : null;

  const loadLocations = () =>
    axiosConfig.perform_get(
      auth,
      '/v1/location/min/',
      (response) => {
        setLocations(Array.isArray(response?.data) ? response.data : []);
        setLocationsLoading(false);
      },
      (error) => {
        showRequestError(enqueueSnackbar, t('devices_locations_failed'), error);
        setLocationsLoading(false);
      },
    );

  useEffect(() => {
    void loadLocations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadOverview = (id: number, ping: boolean) => {
    if (!canList) {
      return Promise.resolve();
    }
    // A new request replaces a running one (its answer is dropped).
    const request = ++requestRef.current;
    setLoading(!ping);
    setPinging(ping);
    return axiosConfig.perform_get(
      auth,
      `/v1/status/location_devices/?location=${id}${ping ? '&ping=1' : ''}`,
      (response) => {
        if (request !== requestRef.current) {
          return;
        }
        const data = response?.data as Overview;
        setOverview(data);
        setLoading(false);
        setPinging(false);
        // Staff: ping right after the list is shown.
        if (!ping && isStaff && data?.devices?.some((device) => device.ip)) {
          void loadOverview(id, true);
        }
      },
      (error) => {
        if (request !== requestRef.current) {
          return;
        }
        showRequestError(enqueueSnackbar, t('devices_load_failed'), error);
        setLoading(false);
        setPinging(false);
      },
    );
  };

  useEffect(() => {
    setOverview(null);
    setFilter('all');
    // Setup and test measurements belong to the previous location.
    setAdding(false);
    setTestDevice(null);
    if (locationId === null) {
      requestRef.current += 1;
      setLoading(false);
      setPinging(false);
      return;
    }
    void loadOverview(locationId, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationId]);

  const selectLocation = (location: PickableLocation | null) => {
    const next = new URLSearchParams(searchParams);
    if (location) {
      next.set('location', String(location.id));
    } else {
      next.delete('location');
    }
    setSearchParams(next, { replace: true });
  };

  // -- delete ------------------------------------------------------------------

  const confirmDelete = () => {
    if (!deleteTarget) {
      return;
    }
    const target = deleteTarget;
    setDeleting(true);
    void axiosConfig.perform_post(
      auth,
      // ?location=: device ids are only unique within one project database.
      `/v1/device/${target.id}/delete/${target.location ? `?location=${target.location}` : ''}`,
      () => {
        showSuccessBar(enqueueSnackbar, t('devices_deleted'));
        setDeleting(false);
        setDeleteTarget(null);
        if (locationId !== null) {
          void loadOverview(locationId, false);
        }
      },
      (error) => {
        showRequestError(enqueueSnackbar, t('devices_delete_failed'), error);
        setDeleting(false);
        setDeleteTarget(null);
      },
    );
  };

  // -- setup -------------------------------------------------------------------

  const syncAirtable = () => {
    setSyncing(true);
    void axiosConfig.perform_post(
      auth,
      '/v1/device/provision/airtable/sync/',
      {},
      (response) => {
        const data = (response?.data || null) as AirtableSync | null;
        setAirtable(data);
        setSyncing(false);
        if (data?.updated.length) {
          // Names may have changed.
          void loadLocations();
        }
      },
      (error) => {
        showRequestError(enqueueSnackbar, 'Could not sync with Airtable', error);
        setSyncing(false);
      },
    );
  };

  const deviceCreated = (device: ProvisionedDevice) => {
    setTestDevice(device);
    if (locationId !== null) {
      void loadOverview(locationId, false);
    }
  };

  // -- rendering ---------------------------------------------------------------

  const stats = overview?.stats ?? null;
  const devices = overview?.devices ?? [];
  const shown = devices.filter((device) =>
    filter === 'online'
      ? device.online
      : filter === 'offline'
        ? !device.online
        : filter === 'project'
          ? device.hash_kind === 'project'
          : true,
  );
  const projectExample = `${overview?.location.project_id ?? 1312}-01`;

  const kpiTiles = stats
    ? [
        {
          label: t('devices_kpi_total'),
          value: String(stats.total),
          note: stats.never_seen ? t('devices_kpi_never_seen', { count: stats.never_seen }) : undefined,
        },
        {
          label: t('devices_kpi_online'),
          value: String(stats.online),
          unit: `/ ${stats.total}`,
          note: t('devices_kpi_offline', { count: stats.offline }),
          valueColor: stats.total && stats.online === stats.total ? GREEN : undefined,
        },
        ...(isStaff
          ? [
              {
                label: t('devices_kpi_ping'),
                value: stats.ping ? String(stats.ping.reachable) : pinging ? '…' : '–',
                unit: stats.ping ? `/ ${stats.ping.reachable + stats.ping.unreachable}` : undefined,
                note: stats.ping
                  ? t('devices_kpi_ping_note', { count: stats.ping.no_ip })
                  : pinging
                    ? t('devices_pinging')
                    : t('devices_kpi_ping_unchecked'),
              },
            ]
          : []),
        {
          label: t('devices_kpi_project_hash'),
          value: String(stats.hash_kinds.project),
          unit: `/ ${stats.total}`,
          note: t('devices_kpi_project_hash_note', { example: projectExample }),
        },
      ]
    : [];

  const statusChip = (device: OverviewDevice) =>
    device.online ? (
      <Chip color={GREEN} background="#EBF4E3">
        <Dot color={GREEN} />
        {t('devices_status_online')}
      </Chip>
    ) : device.last_seen_at ? (
      <Chip color={RED} background="#FBE9E3">
        <Dot color={RED} />
        {t('devices_status_offline')}
      </Chip>
    ) : (
      <Chip>
        <Dot color={MUTED} />
        {t('devices_status_never')}
      </Chip>
    );

  const pingChip = (device: OverviewDevice) => {
    if (!overview?.pinged) {
      return <span style={{ color: MUTED }}>{pinging ? <Spinner animation="border" size="sm" /> : '–'}</span>;
    }
    if (device.ping === null) {
      return <Chip>{t('devices_ping_no_ip')}</Chip>;
    }
    return device.ping ? (
      <Chip color={GREEN} background="#EBF4E3">
        {t('devices_ping_ok')}
      </Chip>
    ) : (
      <Chip color={RED} background="#FBE9E3">
        {t('devices_ping_fail')}
      </Chip>
    );
  };

  const hashChip = (device: OverviewDevice) =>
    device.hash_kind === 'project' ? (
      <Chip color="var(--progeo-blue)" background="#E3ECF4">
        {t('devices_hash_short_project')}
      </Chip>
    ) : (
      <Chip>{t(`devices_hash_short_${device.hash_kind}`)}</Chip>
    );

  // Commands are polled only by controllers on the new hash schema
  // ("<project_id>-<nn>"); the backend refuses the others.
  const commandsButton = (device: OverviewDevice) =>
    device.hash_kind === 'project' ? (
      <button
        type="button"
        title={t('devices_action_commands')}
        aria-label={t('devices_action_commands')}
        onClick={() => setCommandsTarget(device)}
        style={actionStyle()}
      >
        <Terminal size={14} />
      </button>
    ) : (
      // A disabled button shows no tooltip in every browser - the span does.
      <span title={t('devices_action_commands_project_only', { example: projectExample })}>
        <button type="button" disabled aria-label={t('devices_action_commands')} style={actionStyle(true)}>
          <Terminal size={14} />
        </button>
      </span>
    );

  // Stable between renders - DataTable keeps its sorting, the search its texts.
  const columns = useMemo<SearchableColumn<OverviewDevice>[]>(() => [
    {
      id: 'device',
      name: t('devices_col_device'),
      sortable: true,
      grow: 2,
      selector: (device) => device.display_name || device.raw_hash,
      searchText: (device) => `${device.display_name ?? ''} ${device.raw_hash} #${device.id}`,
      cell: (device) => (
        <div style={{ padding: '6px 0', minWidth: 0 }}>
          <div style={{ fontWeight: 500 }}>{device.display_name || device.raw_hash}</div>
          <div className="font-monospace" style={{ fontSize: 11.5, color: MUTED }}>
            {device.raw_hash} · #{device.id}
          </div>
        </div>
      ),
    },
    {
      id: 'type',
      name: t('devices_col_type'),
      sortable: true,
      // The precise model ("smartex dm"); without one the technical class.
      selector: (device) => device.model || device.type || '',
      searchText: (device) => `${device.model ?? ''} ${device.type ?? ''}`,
      cell: (device) =>
        device.model || device.type ? (
          <div>
            <div style={{ fontWeight: 500 }}>{device.model || device.type}</div>
            {device.model && device.type && <div style={{ fontSize: 11.5, color: MUTED }}>{device.type}</div>}
          </div>
        ) : (
          muted
        ),
    },
    {
      id: 'hash',
      name: t('devices_col_hash'),
      sortable: true,
      selector: (device) => device.hash_kind,
      searchText: (device) => t(`devices_hash_short_${device.hash_kind}`),
      cell: hashChip,
    },
    {
      id: 'status',
      name: t('devices_col_status'),
      sortable: true,
      selector: (device) => (device.online ? 2 : device.last_seen_at ? 1 : 0),
      searchText: (device) =>
        t(device.online ? 'devices_status_online' : device.last_seen_at ? 'devices_status_offline' : 'devices_status_never'),
      cell: statusChip,
    },
    {
      id: 'last_seen',
      name: t('devices_col_last_seen'),
      sortable: true,
      selector: (device) => device.last_seen_at ?? '',
      searchText: (device) => (device.last_seen_at ? formatDate(device.last_seen_at, 'dateTimeSeconds') : ''),
      cell: (device) => (
        <span style={{ whiteSpace: 'nowrap' }}>
          {device.last_seen_at ? formatDate(device.last_seen_at, 'dateTimeSeconds') : muted}
        </span>
      ),
    },
    {
      id: 'ip',
      name: t('devices_col_ip'),
      sortable: true,
      selector: (device) => device.ip ?? '',
      cell: (device) => <span className="font-monospace">{device.ip || muted}</span>,
    },
    ...(isStaff
      ? [
          {
            id: 'ping',
            name: t('devices_col_ping'),
            selector: (device: OverviewDevice) => (device.ping === null ? -1 : Number(device.ping)),
            sortable: true,
            cell: pingChip,
          },
        ]
      : []),
    {
      id: 'actions',
      name: '',
      right: true,
      grow: 0,
      width: '210px',
      ignoreRowClick: true,
      cell: (device) => (
        <div style={{ display: 'inline-flex', gap: 6 }}>
          {canCommands && commandsButton(device)}
          {/* "Einstellungen" is a superuser-only portal page. */}
          {canEdit && isSuperuser && device.location && (
            <button
              type="button"
              title={t('devices_action_settings')}
              aria-label={t('devices_action_settings')}
              onClick={() => navigate(`/location/${device.location}/einstellungen`)}
              style={actionStyle()}
            >
              <Sliders size={14} />
            </button>
          )}
          {/* Sensors are placed in the Lageplan wizard (superuser-only). */}
          {canEdit && isSuperuser && device.location && (
            <button
              type="button"
              title={t('devices_action_editor')}
              aria-label={t('devices_action_editor')}
              onClick={() => navigate(`/lageplan/wizard/?location=${device.location}`)}
              style={actionStyle()}
            >
              <Image size={14} />
            </button>
          )}
          {canProvision && device.location && (
            <button
              type="button"
              title={t('devices_action_test_measurements')}
              aria-label={t('devices_action_test_measurements')}
              onClick={() => setTestDevice({ id: device.id, location: device.location!, raw_hash: device.raw_hash })}
              style={actionStyle()}
            >
              <Activity size={14} />
            </button>
          )}
          {canDelete && <DeleteIconButton label={t('devices_action_delete')} onClick={() => setDeleteTarget(device)} />}
        </div>
      ),
    },
    // The chips and buttons only read these.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [t, isStaff, isSuperuser, canEdit, canDelete, canProvision, canCommands, overview?.pinged, pinging, projectExample]);


  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <PanelCard
        title={t('devices_title')}
        actions={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {isStaff && (
              <PillButton
                variant="ghost"
                icon={syncing ? <Spinner animation="border" size="sm" /> : <ArrowRepeat size={14} />}
                label={t('devices_airtable_sync')}
                disabled={syncing}
                onClick={syncAirtable}
              />
            )}
            {locationId !== null && isStaff && canList && (
              <PillButton
                variant="ghost"
                icon={pinging ? <Spinner animation="border" size="sm" /> : <Broadcast size={14} />}
                label={pinging ? t('devices_pinging') : t('devices_ping')}
                disabled={pinging || loading}
                onClick={() => void loadOverview(locationId, true)}
              />
            )}
            {locationId !== null && canList && (
              <PillButton
                variant="ghost"
                icon={loading ? <Spinner animation="border" size="sm" /> : <ArrowClockwise size={14} />}
                label={t('devices_refresh')}
                disabled={loading}
                onClick={() => void loadOverview(locationId, false)}
              />
            )}
            {locationId !== null && canProvision && (
              <PillButton
                variant="accent"
                icon={<PlusCircle size={14} />}
                label={t('devices_add')}
                disabled={adding}
                onClick={() => setAdding(true)}
              />
            )}
          </div>
        }
      >
        <div style={{ maxWidth: 560 }}>
          <LocationPicker
            id="device-overview-location"
            locations={locations}
            value={locationId}
            onChange={selectLocation}
            loading={locationsLoading}
          />
        </div>
        {locationId === null && (
          <div style={{ fontSize: 12.5, color: MUTED, marginTop: 10 }}>{t('devices_pick_location')}</div>
        )}
      </PanelCard>

      {airtable && (
        <AirtableSyncPanel
          // A new sync starts a fresh selection.
          key={airtable.signed}
          initial={airtable}
          onClose={() => setAirtable(null)}
          onLocationsChanged={() => void loadLocations()}
        />
      )}

      {locationId !== null && adding && (
        <DeviceProvisionPanel
          key={locationId}
          locationId={locationId}
          onCreated={deviceCreated}
          onClose={() => setAdding(false)}
        />
      )}

      {testDevice && (
        <ProvisionTestMeasurements
          // A fresh instance per device: its polls merge new rows into the
          // shown ones, so a reused instance mixed the devices' measurements.
          key={`${testDevice.location}-${testDevice.id}`}
          locationId={testDevice.location}
          deviceId={testDevice.id}
          deviceHash={testDevice.raw_hash}
          onClose={() => setTestDevice(null)}
        />
      )}

      {locationId !== null && loading && !overview && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 30 }}>
          <Spinner animation="border" />
        </div>
      )}

      {stats && (
        <>
          <KpiStrip tiles={kpiTiles} />

          <PanelCard title={t('devices_hashes')}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                gap: '10px 24px',
              }}
            >
              {HASH_KINDS.map((kind) => (
                <CountBar
                  key={kind}
                  label={t(`devices_hash_${kind}`, { example: projectExample })}
                  count={stats.hash_kinds[kind]}
                  total={stats.total}
                />
              ))}
            </div>
            <div style={{ fontSize: 12, color: MUTED, marginTop: 12 }}>{t('devices_online_hint')}</div>
          </PanelCard>

          <PanelCard
            title={t('devices_list', { name: overview?.location.name || `#${overview?.location.id}` })}
            actions={
              <SegmentedControl
                options={[
                  { value: 'all', label: `${t('devices_filter_all')} · ${stats.total}` },
                  { value: 'online', label: `${t('devices_filter_online')} · ${stats.online}` },
                  { value: 'offline', label: `${t('devices_filter_offline')} · ${stats.offline}` },
                  { value: 'project', label: `${t('devices_filter_project')} · ${stats.hash_kinds.project}` },
                ]}
                value={filter}
                onChange={(value) => setFilter(value as Filter)}
              />
            }
          >
            {shown.length === 0 ? (
              <div style={{ fontSize: 13, color: MUTED, padding: '8px 0' }}>
                {devices.length === 0 ? t('devices_none') : t('devices_none_filtered')}
              </div>
            ) : (
              <SearchableDataTable
                columns={columns}
                data={shown}
                keyField="id"
                defaultSortFieldId="device"
                highlightOnHover
                labels={{
                  placeholder: t('devices_search'),
                  count: (count, total) => t('devices_search_count', { count, total }),
                }}
              />
            )}
          </PanelCard>
        </>
      )}

      {commandsTarget && (
        <DeviceCommandsDialog
          device={commandsTarget}
          isSuperuser={isSuperuser}
          canEdit={canCommands}
          onClose={() => setCommandsTarget(null)}
        />
      )}

      <ConfirmDialog
        show={deleteTarget !== null}
        title={t('devices_delete_title')}
        message={t('devices_delete_message', { name: deleteTarget?.display_name || deleteTarget?.raw_hash })}
        confirmLabel={t('devices_action_delete')}
        cancelLabel={t('devices_cancel')}
        confirming={deleting}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
};

export default DeviceListView;
