import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Form, Spinner } from 'react-bootstrap';
import { ArrowRepeat } from 'react-bootstrap-icons';
import DataTable, { type TableColumn } from 'react-data-table-component';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useSnackbar } from 'notistack';
import { useAuth } from '../../hooks/CoreAuthProvider';
import axiosConfig from '../axiosConfig';
import PanelCard from '../components/ui/kit/PanelCard';
import PillButton from '../components/ui/kit/PillButton';
import SegmentedControl from '../components/ui/kit/SegmentedControl';
import { showRequestError, showSuccessBar } from '../components/ui/Snackbar.jsx';
import { repeatedTestId } from '../testIds';
import {
  LocationFlagIcons,
  isLocationOff,
  locationOffRowStyle,
  setLocationFlags,
  useLocationFlags,
  type LocationFlags,
} from '../components/location/locationFlags';
import './NotificationLocationsPanel.css';

/** A row of GET /v1/notification-location/. */
export type NotificationLocation = {
  id: number;
  name: string | null;
  project_id: number | null;
  city: string | null;
  account_name: string | null;
  notifications_disabled: boolean;
  open_cases: number;
  withheld_last_week: number;
};

type Filter = 'disabled' | 'enabled' | 'all';
type Counts = { disabled: number; enabled: number };

const API_URL = '/v1/notification-location/';

const matches = (row: NotificationLocation, needle: string) =>
  [row.name, row.project_id, row.account_name, row.city]
    .some((value) => value != null && String(value).toLowerCase().includes(needle));

/**
 * Device statistics -> "Benachrichtigungen pro Objekt": the locations whose
 * notifications are switched off (ProgeoLocation.notifications_disabled, the
 * default) with a switch per row - staff switch them on one after another.
 * Disabled locations still get their cases and logged messages; only
 * nothing is sent (helper/outbound.py). A switched row stays in the list
 * until the next reload, so a slip of the finger is undone in place.
 */
const NotificationLocationsPanel = () => {
  const { t } = useTranslation();
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const [filter, setFilter] = useState<Filter>('disabled');
  const [rows, setRows] = useState<NotificationLocation[]>([]);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState<Record<number, boolean>>({});
  // The striped "switched off" rows like every location table: the store
  // (purge mark included), until it answers the row's own switch.
  const { flagsOf } = useLocationFlags(rows.map((row) => row.id));
  const flagsFor = useCallback(
    (row: NotificationLocation): LocationFlags => ({
      purgeable: null,
      ...flagsOf(row.id),
      notifications_disabled: row.notifications_disabled,
    }),
    [flagsOf],
  );

  // `loading` is switched on by whoever asks for the reload (initial state,
  // filter change, refresh) - not inside the effect.
  const load = useCallback(() => {
    void axiosConfig.perform_get(
      auth,
      `${API_URL}?state=${filter}`,
      (response) => {
        setRows((response?.data?.locations ?? []) as NotificationLocation[]);
        setCounts((response?.data?.counts ?? null) as Counts | null);
        setLoading(false);
      },
      (error) => {
        setLoading(false);
        showRequestError(enqueueSnackbar, t('notification_locations_load_error'), error);
      },
    );
  }, [auth, enqueueSnackbar, filter, t]);

  useEffect(() => {
    load();
  }, [load]);

  const toggle = useCallback(
    (row: NotificationLocation) => {
      const disabled = !row.notifications_disabled;
      setBusy((current) => ({ ...current, [row.id]: true }));
      void axiosConfig.perform_post(
        auth,
        `${API_URL}${row.id}/toggle/`,
        { disabled },
        (response) => {
          const saved = response?.data?.location as NotificationLocation | undefined;
          const now = saved?.notifications_disabled ?? disabled;
          setRows((current) =>
            current.map((entry) => (entry.id === row.id ? { ...entry, notifications_disabled: now } : entry)),
          );
          if (response?.data?.counts) {
            setCounts(response.data.counts as Counts);
          }
          setLocationFlags(row.id, { notifications_disabled: now });
          setBusy((current) => ({ ...current, [row.id]: false }));
          showSuccessBar(
            enqueueSnackbar,
            t(now ? 'notification_locations_switched_off' : 'notification_locations_switched_on', {
              name: row.name || row.project_id || row.id,
            }),
          );
        },
        (error) => {
          setBusy((current) => ({ ...current, [row.id]: false }));
          showRequestError(enqueueSnackbar, t('notification_locations_toggle_error'), error);
        },
      );
    },
    [auth, enqueueSnackbar, t],
  );

  const needle = search.trim().toLowerCase();
  const visible = needle ? rows.filter((row) => matches(row, needle)) : rows;

  const columns = useMemo<TableColumn<NotificationLocation>[]>(
    () => [
      {
        name: t('notification_locations_col_location'),
        selector: (row) => row.name ?? '',
        sortable: true,
        minWidth: '180px',
        wrap: true,
        cell: (row) => (
          <div className="small">
            <LocationFlagIcons flags={flagsFor(row)} testKey={`notification-${row.id}`} />
            <Link to={`/location/${row.id}/status`} {...repeatedTestId('notification-locations-link', row.id)}>
              {row.name || '–'}
            </Link>
            {row.project_id != null && <span className="text-muted"> #{row.project_id}</span>}
            {row.city && <span className="text-muted d-block">{row.city}</span>}
          </div>
        ),
      },
      {
        name: t('notification_locations_col_account'),
        selector: (row) => row.account_name ?? '',
        sortable: true,
        minWidth: '140px',
        wrap: true,
        cell: (row) => <span className="small">{row.account_name || '–'}</span>,
      },
      {
        name: t('notification_locations_col_open_cases'),
        selector: (row) => row.open_cases,
        sortable: true,
        width: '120px',
        cell: (row) =>
          row.open_cases ? (
            <Badge bg="warning" text="dark">{row.open_cases}</Badge>
          ) : (
            <span className="notification-locations-muted">0</span>
          ),
      },
      {
        name: t('notification_locations_col_withheld'),
        selector: (row) => row.withheld_last_week,
        sortable: true,
        width: '150px',
        cell: (row) =>
          row.withheld_last_week ? (
            <Badge bg="secondary">{row.withheld_last_week}</Badge>
          ) : (
            <span className="notification-locations-muted">0</span>
          ),
      },
      {
        name: t('notification_locations_col_switch'),
        selector: (row) => (row.notifications_disabled ? 0 : 1),
        sortable: true,
        width: '170px',
        cell: (row) => (
          <Form.Check
            type="switch"
            id={`notification-location-switch-${row.id}`}
            className="notification-locations-switch"
            checked={!row.notifications_disabled}
            disabled={Boolean(busy[row.id])}
            onChange={() => toggle(row)}
            label={row.notifications_disabled ? t('notification_locations_off') : t('notification_locations_on')}
            {...repeatedTestId('notification-locations-switch', row.id)}
          />
        ),
      },
    ],
    [busy, flagsFor, t, toggle],
  );

  const filterOptions = [
    { value: 'disabled', label: t('notification_locations_filter_disabled', { count: counts?.disabled ?? 0 }) },
    { value: 'enabled', label: t('notification_locations_filter_enabled', { count: counts?.enabled ?? 0 }) },
    { value: 'all', label: t('notification_locations_filter_all') },
  ];

  return (
    <PanelCard
      testId="notification-locations"
      title={t('notification_locations_title')}
      actions={
        <div className="d-flex align-items-center gap-2 flex-wrap">
          <SegmentedControl
            options={filterOptions}
            value={filter}
            onChange={(value) => {
              if (value !== filter) {
                setLoading(true);
                setFilter(value as Filter);
              }
            }}
            disabled={loading}
            testId="notification-locations-filter"
          />
          <PillButton
            variant="ghost"
            icon={loading ? <Spinner animation="border" size="sm" /> : <ArrowRepeat size={14} />}
            label={t('device_stats_refresh')}
            onClick={() => {
              setLoading(true);
              load();
            }}
            disabled={loading}
            testId="notification-locations-refresh"
          />
        </div>
      }
    >
      <div className="small notification-locations-muted mb-2">{t('notification_locations_hint')}</div>
      <Form.Control
        size="sm"
        type="search"
        className="notification-locations-search mb-2"
        placeholder={t('notification_locations_search')}
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        data-testid="notification-locations-search"
      />
      <DataTable
        columns={columns}
        data={visible}
        dense
        conditionalRowStyles={[locationOffRowStyle((row: NotificationLocation) => isLocationOff(flagsFor(row)))]}
        pagination
        paginationPerPage={15}
        paginationRowsPerPageOptions={[15, 30, 50, 100]}
        progressPending={loading}
        progressComponent={
          <div className="d-flex align-items-center gap-2 text-muted py-3">
            <Spinner animation="border" size="sm" />
            {t('ui_loading')}
          </div>
        }
        noDataComponent={
          <div className="small text-muted py-2" data-testid="notification-locations-empty">
            {t('notification_locations_empty')}
          </div>
        }
      />
    </PanelCard>
  );
};

export default NotificationLocationsPanel;
