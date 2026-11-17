import { useEffect, useMemo, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import DataTable, { Media } from 'react-data-table-component';
import type { TableColumn } from 'react-data-table-component';
import { Alert, Form, Spinner } from 'react-bootstrap';
import { Bell, Search, XLg } from 'react-bootstrap-icons';
import { useSnackbar } from 'notistack';
import { useNavigate } from 'react-router';

import { useAuth } from '../../hooks/CoreAuthProvider';
import usePermissions from '../../hooks/usePermissions';
import axiosConfig from '../axiosConfig';
import { matchesLocationSearch } from '../components/location/locationSearch';
import { showRequestError } from '../components/ui/Snackbar.jsx';
import PanelCard from '../components/ui/kit/PanelCard';
import PillButton from '../components/ui/kit/PillButton';
import { progeoTableStyles } from '../components/ui/kit/SearchableDataTable';
import { formatDate, formatRelativeTime } from './dateFormat';
import { getProjectTypeLabel } from './projectType';
import { repeatedTestId } from '../testIds';
import {
  LocationFlagIcons,
  locationFlagRowStyles,
  useLocationFlags,
  type LocationFlags,
} from '../components/location/locationFlags';
import {
  LOCATION_LIST_CLASS,
  LocationNameCell,
  TwoLineCell,
  isRecentMeasurement,
  locationAddressLine,
} from '../components/location/LocationListCells';

import { untaggedRowClick } from './wholeRowClick';
import './LocationsOverview.css';

type FlagsOf = (id: number | null | undefined) => LocationFlags | null;

type LocationRow = {
  id: number;
  name?: string | null;
  city?: string | null;
  address?: string | null;
  plz?: string | null;
  project_id?: number | null;
  /** ProgeoLocation.PROJECT_TYPE_CHOICES - the product (smartex® dm, ...). */
  project_type?: number | null;
  measurement_count?: number;
  last_measurement_at?: string | null;
};

type LocationAlarmSummary = {
  count: number;
  active: number;
};

/** A row of GET /v1/alarm/active/: a not yet normalized alarm. */
type ActiveAlarm = {
  id: number;
  triggered_at: string | null;
  still_active_at: string | null;
  status: string | null;
  sensor_id: number | null;
  max_value: number | null;
  threshold: number | null;
  device: { id: number; raw_hash: string; display_name: string };
  location: {
    id: number;
    name: string | null;
    project_id: number | null;
    city: string | null;
  };
};

type TFn = TFunction;

/** Alarm status labels of the backend (ProgeoAlarm.Status) - translated. */
const ALARM_STATUS_KEYS: Record<string, string> = {
  neu: 'ui_neu',
  quittiert: 'ui_quittiert',
  geloest: 'ui_geloest',
};

/** Columns of the active alarms list (a row opens its location's alarms). */
const activeAlarmColumnsFor = (flagsOf: FlagsOf, t: TFn): TableColumn<ActiveAlarm>[] => [
  {
    name: t('locations_col_triggered'),
    selector: (row) => row.triggered_at ?? '',
    format: (row) => formatDate(row.triggered_at, 'dateTime'),
    sortable: true,
    width: '160px',
  },
  {
    name: t('locations_col_project'),
    selector: (row) => row.location.project_id ?? '-',
    sortable: true,
    width: '110px',
  },
  {
    name: t('locations_col_location'),
    selector: (row) => row.location.name || '-',
    cell: (row) => (
      <span className="location-list-name-wrap" {...repeatedTestId('locations-active-alarm', row.id)}>
        <TwoLineCell
          primary={
            <>
              <LocationFlagIcons flags={flagsOf(row.location.id)} testKey={`active-alarm-${row.id}`} />
              {row.location.name || '–'}
            </>
          }
          secondary={row.location.city || undefined}
        />
      </span>
    ),
    sortable: true,
    grow: 1.6,
  },
  {
    name: t('locations_col_device'),
    selector: (row) => row.device.display_name,
    sortable: true,
    grow: 1.2,
  },
  {
    name: t('locations_col_sensor'),
    selector: (row) => row.sensor_id ?? 0,
    format: (row) => (row.sensor_id != null ? `S${row.sensor_id}` : '-'),
    sortable: true,
    width: '90px',
  },
  {
    name: t('locations_col_value'),
    selector: (row) => row.max_value ?? 0,
    format: (row) =>
      row.max_value != null
        ? `${row.max_value}${row.threshold != null ? ` / ${row.threshold}` : ''}`
        : '-',
    sortable: true,
    width: '120px',
  },
  {
    name: t('locations_col_status'),
    selector: (row) => row.status ?? '-',
    format: (row) =>
      row.status && ALARM_STATUS_KEYS[row.status] ? t(ALARM_STATUS_KEYS[row.status]) : (row.status ?? '-'),
    sortable: true,
    width: '110px',
  },
];

/**
 * Row colouring (classes in LocationsOverview.css): ProGeo orange = open
 * alarms, green = online, grey = offline or never measured.
 */
const ROW_CLASSES = {
  alarm: 'locations-row--alarm',
  online: 'locations-row--online',
  offline: 'locations-row--offline',
  none: 'locations-row--none',
};

/** Query of /v1/location/min/: the search text, only connected locations. */
const locationsQuery = (search: string, hasDevice: boolean) => {
  const params = new URLSearchParams();
  if (search.trim()) {
    params.set('search', search.trim());
  }
  if (hasDevice) {
    params.set('has_device', '1');
  }
  return params.toString();
};

/**
 * Alarm summaries merged with a new batch for `ids`. The backend only returns
 * an entry for locations that actually have alarms - the rest are backfilled
 * with an explicit zero, so an absent key reliably means "not loaded yet"
 * (the State column's loading-spinner check) rather than "confirmed no alarms".
 */
const mergeAlarmSummary = (
  current: Record<string, LocationAlarmSummary>,
  loaded: Record<string, LocationAlarmSummary>,
  ids: number[],
) => {
  const merged = { ...current, ...loaded };
  const missing = ids.filter((id) => !(String(id) in merged));
  return {
    ...merged,
    ...Object.fromEntries(missing.map((id) => [String(id), { count: 0, active: 0 }])),
  };
};

/** Rows with the detail fields of `details` merged in. */
const mergeDetails = (rows: LocationRow[], details: LocationRow[]) => {
  const detailsById = new Map(details.map((detail) => [detail.id, detail]));
  return rows.map((row) => {
    const detail = detailsById.get(row.id);
    return detail ? { ...row, ...detail } : row;
  });
};

type LocationState = keyof typeof ROW_CLASSES;

/** 25 rows by default - the rows are roomier than they were. */
export const OVERVIEW_ROWS_PER_PAGE = 25;
const OVERVIEW_ROWS_PER_PAGE_OPTIONS = [10, 25, 50, 100];

/** Online = a measurement within RECENT_MEASUREMENT_HOURS (as on /status and the device list). */
export type Connectivity = 'online' | 'offline' | 'none';

export const locationConnectivity = (
  row: Pick<LocationRow, 'last_measurement_at'>,
  now: number = Date.now(),
): Connectivity => {
  if (!row.last_measurement_at) {
    return 'none';
  }
  return isRecentMeasurement(row.last_measurement_at, now) ? 'online' : 'offline';
};

/** The row colour - open alarms first, then online/offline. */
export const locationState = (
  row: Pick<LocationRow, 'last_measurement_at'>,
  summary: LocationAlarmSummary | undefined,
  now: number = Date.now(),
): LocationState => (summary && summary.count > 0 ? 'alarm' : locationConnectivity(row, now));

const CONNECTIVITY_KEYS: Record<Connectivity, string> = {
  online: 'locations_state_online',
  offline: 'locations_state_offline',
  none: 'locations_state_no_data',
};

/** The State column: a dot and Online / Offline / No data - a spinner until the details are loaded. */
const LocationStateCell = ({ row, t }: { row: LocationRow; t: TFn }) => {
  if (row.measurement_count === undefined) {
    return (
      <div className="d-flex align-items-center gap-2 text-muted" {...repeatedTestId('locations-state-loading', row.id)}>
        <Spinner size="sm" animation="border" />
      </div>
    );
  }
  const connectivity = locationConnectivity(row);
  return (
    <div className="locations-state" {...repeatedTestId('locations-state', row.id)}>
      <span className={`locations-state-dot locations-state-dot--${connectivity}`} />
      <span>{t(CONNECTIVITY_KEYS[connectivity])}</span>
    </div>
  );
};

/** The Alarm column: "2/3 active" with an orange dot, "–" without alarms. */
const LocationAlarmCell = ({
  row,
  summary,
  t,
}: {
  row: LocationRow;
  summary: LocationAlarmSummary | undefined;
  t: TFn;
}) => {
  if (!summary) {
    return (
      <div className="d-flex align-items-center gap-2 text-muted" {...repeatedTestId('locations-alarm-loading', row.id)}>
        <Spinner size="sm" animation="border" />
      </div>
    );
  }
  if (summary.count === 0) {
    return (
      <span className="location-list-muted" {...repeatedTestId('locations-alarm', row.id)}>
        –
      </span>
    );
  }
  return (
    <div className="locations-state locations-state--alarm" {...repeatedTestId('locations-alarm', row.id)}>
      <span className="locations-state-dot locations-state-dot--alarm" />
      <span>{t('locations_state_active', { active: summary.active, count: summary.count })}</span>
    </div>
  );
};

/** The Last measurement column: how long ago (green while recent), the date as tooltip. */
const LastMeasurementCell = ({ row, t }: { row: LocationRow; t: TFn }) => {
  if (row.measurement_count === undefined) {
    // Details not loaded yet - the State column shows the spinner.
    return null;
  }
  if (!row.last_measurement_at) {
    return <span className="location-list-muted">{t('locations_never_measured')}</span>;
  }
  return (
    <span
      className={`location-list-muted${isRecentMeasurement(row.last_measurement_at) ? ' location-list-recent' : ''}`}
      title={formatDate(row.last_measurement_at, 'dateTime')}
      {...repeatedTestId('locations-last-measurement', row.id)}
    >
      {formatRelativeTime(row.last_measurement_at)}
    </span>
  );
};

/** Columns of the locations table: compact rows, details as a muted second line. */
const locationColumns = ({
  alarmSummary,
  flagsOf,
  t,
}: {
  alarmSummary: Record<string, LocationAlarmSummary>;
  /** Staff: the switched-off flags (locationFlags.tsx) - null for everyone else. */
  flagsOf: FlagsOf;
  t: TFn;
}): TableColumn<LocationRow>[] => [
  {
    id: 'project',
    name: t('locations_col_project'),
    selector: (row) => row.project_id ?? 0,
    cell: (row) => <span className="location-list-num">{row.project_id ?? '–'}</span>,
    sortable: true,
    width: '90px',
  },
  {
    id: 'name',
    name: t('locations_col_name'),
    selector: (row) => row.name || '',
    // The star pins the location as favorite; the address is the second line.
    cell: (row) => (
      <span className="location-list-name-wrap" {...repeatedTestId('locations-row', row.id)}>
        <LocationNameCell
          locationId={row.id}
          name={row.name || '–'}
          subline={locationAddressLine(row)}
          flags={flagsOf(row.id)}
          testKey={`location-${row.id}`}
        />
      </span>
    ),
    sortable: true,
    grow: 2.4,
    minWidth: '220px',
  },
  {
    id: 'product',
    name: t('locations_col_product'),
    selector: (row) => (row.project_type ? getProjectTypeLabel(t, row.project_type) : ''),
    cell: (row) =>
      row.project_type ? (
        <span className="location-list-product">{getProjectTypeLabel(t, row.project_type)}</span>
      ) : (
        <span className="location-list-muted">–</span>
      ),
    sortable: true,
    width: '130px',
    hide: Media.MD,
  },
  {
    id: 'state',
    name: t('locations_col_state'),
    // Online first, then offline, never measured last.
    selector: (row) => ({ online: 2, offline: 1, none: 0 })[locationConnectivity(row)],
    cell: (row) => <LocationStateCell row={row} t={t} />,
    sortable: true,
    width: '130px',
  },
  {
    id: 'alarm',
    name: t('locations_col_alarm'),
    selector: (row) => alarmSummary[String(row.id)]?.active ?? -1,
    cell: (row) => <LocationAlarmCell row={row} summary={alarmSummary[String(row.id)]} t={t} />,
    sortable: true,
    width: '130px',
  },
  {
    id: 'last-measurement',
    name: t('locations_col_last_measurement'),
    selector: (row) => row.last_measurement_at ?? '',
    cell: (row) => <LastMeasurementCell row={row} t={t} />,
    sortable: true,
    width: '150px',
    hide: Media.SM,
  },
];

/** Row colors by state (see locationState). */
const rowStylesFor = (alarmSummary: Record<string, LocationAlarmSummary>) =>
  (Object.keys(ROW_CLASSES) as LocationState[]).map((state) => ({
    when: (row: LocationRow) => locationState(row, alarmSummary[String(row.id)]) === state,
    classNames: [ROW_CLASSES[state]],
  }));

const LocationsOverview = () => {
  const auth = useAuth();
  const { t } = useTranslation();
  const { hasPermission } = usePermissions();
  // Backend: /v1/alarm/active/ requires module_measurements_enabled.
  const canListAlarms = hasPermission('module_measurements_enabled');
  const navigate = useNavigate();
  const { enqueueSnackbar } = useSnackbar();
  // Only auto-forward on the very first load (an account with a single
  // location goes straight into the LocationDetailView).
  const autoForwarded = useRef(false);
  const [rows, setRows] = useState<LocationRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [alarmSummary, setAlarmSummary] = useState<
    Record<string, LocationAlarmSummary>
  >({});
  const [searchText, setSearchText] = useState('');
  const [onlyConnected, setOnlyConnected] = useState(true);
  const [currentPage, setCurrentPage] = useState(1);
  const [rowsPerPage, setRowsPerPage] = useState(OVERVIEW_ROWS_PER_PAGE);
  // Ids for which the full detail fields (device/measurement counts) were
  // already loaded, so the paginated table only fetches what's missing.
  const loadedDetailIds = useRef<Set<number>>(new Set());
  // Ids for which the alarm summary was already loaded, same on-page-demand pattern.
  const loadedAlarmIds = useRef<Set<number>>(new Set());
  // "Active alarms": every open alarm of all locations, loaded on demand.
  const [activeAlarms, setActiveAlarms] = useState<ActiveAlarm[] | null>(null);
  const [activeTruncated, setActiveTruncated] = useState(false);
  const [loadingActive, setLoadingActive] = useState(false);

  const fetchActiveAlarms = () => {
    setLoadingActive(true);
    void axiosConfig.perform_get(
      auth,
      '/v1/alarm/active/',
      (response) => {
        setActiveAlarms((response?.data?.alarms || []) as ActiveAlarm[]);
        setActiveTruncated(Boolean(response?.data?.truncated));
        setLoadingActive(false);
      },
      (error) => {
        showRequestError(enqueueSnackbar, t('locations_error_active_alarms'), error);
        setLoadingActive(false);
      },
    );
  };

  const fetchLocations = (search = '', hasDevice = false) => {
    setLoading(true);
    void axiosConfig.perform_get(
      auth,
      `/v1/location/min/?${locationsQuery(search, hasDevice)}`,
      (response) => {
        const next = (response?.data || []) as LocationRow[];
        loadedDetailIds.current.clear();
        loadedAlarmIds.current.clear();
        setRows(next);
        setLoading(false);
        // Single-location accounts land directly in the LocationDetailView.
        if (
          !autoForwarded.current &&
          next.length === 1 &&
          next[0]?.id != null
        ) {
          autoForwarded.current = true;
          navigate(`/location/${next[0].id}/status`);
        }
      },
      (error) => {
        showRequestError(enqueueSnackbar, t('locations_error_load'), error);
        setLoading(false);
      },
    );
  };

  // Load alarm counts per location separately, so the location list stays
  // light and the rows can be colored by alarm state. Only fetches for the
  // ids currently visible on screen, merging into the existing summary.
  const fetchAlarmSummary = (ids: number[]) => {
    if (ids.length === 0) {
      return;
    }
    ids.forEach((id) => loadedAlarmIds.current.add(id));

    void axiosConfig.perform_get(
      auth,
      `/v1/alarm/location_summary/?ids=${ids.join(',')}`,
      (response) => {
        const payload = (response?.data?.locations || {}) as Record<
          string,
          LocationAlarmSummary
        >;
        setAlarmSummary((prev) => mergeAlarmSummary(prev, payload, ids));
      },
      (error) => {
        ids.forEach((id) => loadedAlarmIds.current.delete(id));
        showRequestError(
          enqueueSnackbar,
          t('locations_error_alarm_summary'),
          error,
        );
      },
    );
  };

  useEffect(() => {
    fetchLocations(searchText, onlyConnected);
    // Per filter switch only: typing in the search filters the loaded rows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onlyConnected]);

  // Batch-load the full fields (device/measurement counts) for ids that
  // aren't loaded yet, so /min stays fast and details trickle in per page.
  const fetchLocationDetails = (ids: number[]) => {
    if (ids.length === 0) {
      return;
    }
    ids.forEach((id) => loadedDetailIds.current.add(id));

    void axiosConfig.perform_get(
      auth,
      `/v1/location/details/?ids=${ids.join(',')}&skip_lageplans=1`,
      (response) => {
        const details = (response?.data || []) as LocationRow[];
        setRows((prev) => mergeDetails(prev, details));
      },
      (error) => {
        // Allow a retry on the next page change instead of silently missing data.
        ids.forEach((id) => loadedDetailIds.current.delete(id));
        showRequestError(
          enqueueSnackbar,
          t('locations_error_details'),
          error,
        );
      },
    );
  };

  const handleRowClick = (row: LocationRow) => {
    navigate(`/location/${row.id}/status`);
  };

  const openAlarmRow = (row: ActiveAlarm) => navigate(`/location/${row.location.id}/alarms`);

  const paginationOptions = {
    rowsPerPageText: t('locations_rows_per_page'),
    rangeSeparatorText: t('locations_range_separator'),
  };

  const filteredRows = useMemo(() => {
    return rows.filter((row) => matchesLocationSearch(row, searchText));
  }, [rows, searchText]);

  // Fetch the missing detail fields and alarm summary only for the page
  // currently on screen.
  useEffect(() => {
    const start = (currentPage - 1) * rowsPerPage;
    const visibleIds = filteredRows
      .slice(start, start + rowsPerPage)
      .map((row) => row.id);

    const missingDetailIds = visibleIds.filter(
      (id) => !loadedDetailIds.current.has(id),
    );
    if (missingDetailIds.length > 0) {
      fetchLocationDetails(missingDetailIds);
    }

    const missingAlarmIds = visibleIds.filter(
      (id) => !loadedAlarmIds.current.has(id),
    );
    if (missingAlarmIds.length > 0) {
      fetchAlarmSummary(missingAlarmIds);
    }
    // Per visible page: the fetch functions are new on every render, the
    // loaded*Ids refs keep ids from being requested twice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredRows, currentPage, rowsPerPage]);

  // Staff: switched-off locations striped (grey), purgeable ones red.
  const { flagsOf } = useLocationFlags([
    ...rows.map((row) => row.id),
    ...(activeAlarms ?? []).map((row) => row.location.id),
  ]);

  const columns = locationColumns({ alarmSummary, flagsOf, t });
  // The stripes first (purgeable red, switched off grey): the table keeps the
  // style of the last matching rule, so the state colour stays.
  const conditionalRowStyles = [
    ...locationFlagRowStyles((row: LocationRow) => flagsOf(row.id)),
    ...rowStylesFor(alarmSummary),
  ];

  const filters = (
    <div className="locations-filters" data-testid="locations-filters">
      <div className="progeo-table-search locations-search">
        <Search aria-hidden size={13} className="progeo-table-search-icon" />
        <input
          type="search"
          value={searchText}
          placeholder={t('locations_search_placeholder')}
          aria-label={t('locations_search_placeholder')}
          onChange={(event) => {
            setSearchText(event.target.value);
            setCurrentPage(1);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setSearchText('');
              setCurrentPage(1);
            }
          }}
          className="progeo-table-search-input"
          data-testid="locations-search"
        />
        {searchText && (
          <button
            type="button"
            onClick={() => {
              setSearchText('');
              setCurrentPage(1);
            }}
            aria-label={t('locations_search_clear')}
            title={t('locations_search_clear')}
            className="progeo-table-search-clear"
          >
            <XLg size={10} />
          </button>
        )}
      </div>
      <Form.Check
        id="locations-only-connected"
        data-testid="locations-only-connected"
        type="switch"
        className="locations-only-connected"
        label={t('locations_only_connected')}
        checked={onlyConnected}
        onChange={(event) => setOnlyConnected(event.target.checked)}
      />
      {canListAlarms && (
        <PillButton
          label={t('locations_active_alarms')}
          icon={loadingActive ? <Spinner size="sm" animation="border" /> : <Bell aria-hidden />}
          onClick={fetchActiveAlarms}
          disabled={loadingActive}
          testId="locations-active-alarms-button"
        />
      )}
    </div>
  );

  return (
    <div className="locations-overview" data-testid="page-location-overview">
      <h2 className="locations-overview-heading">{t('locations_title')}</h2>

      {activeAlarms && (
        <PanelCard
          testId="locations-active-alarms"
          title={
            <span data-testid="locations-active-alarms-count">
              {t('locations_active_alarms_count', {
                count: activeAlarms.length,
                more: activeTruncated ? '+' : '',
              })}
            </span>
          }
          actions={
            <PillButton
              label={t('locations_close')}
              variant="ghost"
              onClick={() => setActiveAlarms(null)}
              testId="locations-active-alarms-close"
            />
          }
        >
          {activeTruncated && (
            <Alert variant="secondary" className="small py-2" data-testid="locations-active-alarms-truncated">
              {t('locations_active_alarms_truncated', { count: activeAlarms.length })}
            </Alert>
          )}
          {activeAlarms.length === 0 ? (
            <div className="locations-empty" data-testid="locations-active-alarms-empty">
              {t('locations_no_active_alarms')}
            </div>
          ) : (
            // Rows keep DataTable's own keyboard handling (Enter on a focused row).
            <div className={LOCATION_LIST_CLASS} onClick={untaggedRowClick(activeAlarms, openAlarmRow)}>
              <DataTable
                columns={activeAlarmColumnsFor(flagsOf, t)}
                data={activeAlarms}
                customStyles={progeoTableStyles}
                conditionalRowStyles={locationFlagRowStyles((row: ActiveAlarm) => flagsOf(row.location.id))}
                pagination
                paginationComponentOptions={paginationOptions}
                highlightOnHover
                pointerOnHover
                onRowClicked={openAlarmRow}
                defaultSortFieldId={1}
                defaultSortAsc={false}
                dense
              />
            </div>
          )}
        </PanelCard>
      )}

      {/* The filters left-aligned in the panel head, right above the table -
          no extra title row; the count on the right. */}
      <PanelCard
        testId="locations-list"
        title={filters}
        actions={
          !loading && (
            <span className="locations-list-count" data-testid="locations-count">
              {t('locations_count', { count: filteredRows.length, total: rows.length })}
            </span>
          )
        }
      >
        {/* Rows keep DataTable's own keyboard handling (Enter on a focused row). */}
        <div
          className={LOCATION_LIST_CLASS}
          onClick={untaggedRowClick(filteredRows, handleRowClick)}
          data-testid="locations-table"
        >
          <DataTable
            columns={columns}
            data={filteredRows}
            customStyles={progeoTableStyles}
            pagination
            paginationPerPage={rowsPerPage}
            paginationRowsPerPageOptions={OVERVIEW_ROWS_PER_PAGE_OPTIONS}
            paginationComponentOptions={paginationOptions}
            onChangePage={(page) => setCurrentPage(page)}
            onChangeRowsPerPage={(newPerPage, page) => {
              setRowsPerPage(newPerPage);
              setCurrentPage(page);
            }}
            progressPending={loading}
            progressComponent={
              <div className="locations-empty">
                <Spinner size="sm" animation="border" />
              </div>
            }
            noDataComponent={<div className="locations-empty">{t('locations_empty')}</div>}
            highlightOnHover
            pointerOnHover
            conditionalRowStyles={conditionalRowStyles}
            onRowClicked={handleRowClick}
          />
        </div>
      </PanelCard>
    </div>
  );
};

export default LocationsOverview;
