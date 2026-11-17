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
import { sortLoadedFirst, useChunkedPreload } from './overviewPreload';
import useIsMobile from '../components/ui/useIsMobile';
import { useMobileColumns } from '../components/ui/kit/mobileTable';
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

/** Placeholder of a cell whose data is still loading - a soft bar, not a spinner. */
const CellLoading = ({ testId, rowId, t }: { testId: string; rowId: number; t: TFn }) => (
  <span className="locations-cell-loading" role="status" aria-label={t('ui_loading')} {...repeatedTestId(testId, rowId)} />
);

/** A cell whose data could not be loaded: a dash, the reason as tooltip. */
const CellFailed = ({ testId, rowId, t }: { testId: string; rowId: number; t: TFn }) => (
  <span className="location-list-muted" title={t('locations_row_failed')} {...repeatedTestId(testId, rowId)}>
    –
  </span>
);

/** The State column: a dot and Online / Offline / No data. */
const LocationStateCell = ({ row, failed, t }: { row: LocationRow; failed: boolean; t: TFn }) => {
  if (row.measurement_count === undefined) {
    return failed ? (
      <CellFailed testId="locations-state-failed" rowId={row.id} t={t} />
    ) : (
      <CellLoading testId="locations-state-loading" rowId={row.id} t={t} />
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
  failed,
  t,
}: {
  row: LocationRow;
  summary: LocationAlarmSummary | undefined;
  failed: boolean;
  t: TFn;
}) => {
  if (!summary) {
    return failed ? (
      <CellFailed testId="locations-alarm-failed" rowId={row.id} t={t} />
    ) : (
      <CellLoading testId="locations-alarm-loading" rowId={row.id} t={t} />
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
const LastMeasurementCell = ({ row, failed, t }: { row: LocationRow; failed: boolean; t: TFn }) => {
  if (row.measurement_count === undefined) {
    return failed ? (
      <CellFailed testId="locations-last-measurement-failed" rowId={row.id} t={t} />
    ) : (
      <CellLoading testId="locations-last-measurement-loading" rowId={row.id} t={t} />
    );
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

/**
 * Phones: one narrow column instead of Zustand + Alarm - the online dot, and
 * the open alarm cases next to it ("2/3") when there are any.
 */
const LocationMobileStateCell = ({
  row,
  summary,
  failed,
  t,
}: {
  row: LocationRow;
  summary: LocationAlarmSummary | undefined;
  failed: boolean;
  t: TFn;
}) => {
  if (row.measurement_count === undefined) {
    return failed ? (
      <CellFailed testId="locations-state-failed" rowId={row.id} t={t} />
    ) : (
      <CellLoading testId="locations-state-loading" rowId={row.id} t={t} />
    );
  }
  const connectivity = locationConnectivity(row);
  return (
    <span
      className="locations-mobile-state"
      title={t(CONNECTIVITY_KEYS[connectivity])}
      {...repeatedTestId('locations-state', row.id)}
    >
      <span className={`locations-state-dot locations-state-dot--${connectivity}`} />
      {summary && summary.count > 0 && (
        <span className="locations-mobile-alarm" {...repeatedTestId('locations-alarm', row.id)}>
          {summary.active}/{summary.count}
        </span>
      )}
    </span>
  );
};

/**
 * What each sortable column sorts by - null while the row's data is still
 * loading (sortLoadedFirst puts those last). The table sorts through this
 * (sortServer), so the rows on screen are known and loaded first.
 */
export const sortValueOf = (
  columnId: string,
  row: LocationRow,
  summary: LocationAlarmSummary | undefined,
  t: TFn,
): string | number | null => {
  const detailsLoaded = row.measurement_count !== undefined;
  switch (columnId) {
    case 'project':
      return row.project_id ?? null;
    case 'name':
      return (row.name || '').toLowerCase();
    case 'product':
      return row.project_type ? getProjectTypeLabel(t, row.project_type) : '';
    case 'state':
      // Online first, then offline, never measured last (descending).
      return detailsLoaded ? { online: 2, offline: 1, none: 0 }[locationConnectivity(row)] : null;
    case 'alarm':
    case 'mobile-state':
      return summary ? summary.active * 10_000 + summary.count : null;
    case 'last-measurement':
      return detailsLoaded ? (row.last_measurement_at ?? '') : null;
    default:
      return null;
  }
};

/** Columns of the locations table: compact rows, details as a muted second line. */
const locationColumns = ({
  alarmSummary,
  failedDetails,
  failedAlarms,
  flagsOf,
  mobile,
  t,
}: {
  /** Phone width: name and the compact state column only (LocationMobileStateCell). */
  mobile: boolean;
  alarmSummary: Record<string, LocationAlarmSummary>;
  /** Rows whose details / alarm summary could not be loaded. */
  failedDetails: Set<number>;
  failedAlarms: Set<number>;
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
    // Phones: the name takes what the expander and the state leave.
    minWidth: mobile ? '0' : '220px',
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
    cell: (row) => <LocationStateCell row={row} failed={failedDetails.has(row.id)} t={t} />,
    sortable: true,
    width: '130px',
    omit: mobile,
  },
  {
    id: 'alarm',
    name: t('locations_col_alarm'),
    selector: (row) => alarmSummary[String(row.id)]?.active ?? -1,
    cell: (row) => (
      <LocationAlarmCell row={row} summary={alarmSummary[String(row.id)]} failed={failedAlarms.has(row.id)} t={t} />
    ),
    sortable: true,
    width: '130px',
    omit: mobile,
  },
  {
    id: 'mobile-state',
    name: t('locations_col_state'),
    cell: (row) => (
      <LocationMobileStateCell
        row={row}
        summary={alarmSummary[String(row.id)]}
        failed={failedDetails.has(row.id)}
        t={t}
      />
    ),
    sortable: true,
    right: true,
    width: '84px',
    omit: !mobile,
  },
  {
    id: 'last-measurement',
    name: t('locations_col_last_measurement'),
    selector: (row) => row.last_measurement_at ?? '',
    cell: (row) => <LastMeasurementCell row={row} failed={failedDetails.has(row.id)} t={t} />,
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
  // Toggled to send the table back to page 1 (a new sort or search).
  const [resetPage, setResetPage] = useState(false);
  const toFirstPage = () => {
    setCurrentPage(1);
    setResetPage((current) => !current);
  };
  // The table sorts through us (sortServer): the rows on screen are known.
  const [sort, setSort] = useState<{ id: string; ascending: boolean } | null>(null);
  // Rows whose details / alarm summary could not be loaded - a dash, not a
  // placeholder forever; one error message per list.
  const [failedDetails, setFailedDetails] = useState<Set<number>>(new Set());
  const [failedAlarms, setFailedAlarms] = useState<Set<number>>(new Set());
  const errorShown = useRef(false);
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
        // A new list: what was loaded or queued for the old one is dropped.
        preload.reset();
        errorShown.current = false;
        setAlarmSummary({});
        setFailedDetails(new Set());
        setFailedAlarms(new Set());
        setRows(next);
        setLoading(false);
        // Everything in the background - the rows on screen move ahead.
        preload.enqueue(next.map((row) => row.id));
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

  const showLoadError = (message: string, error: unknown) => {
    if (!errorShown.current) {
      errorShown.current = true;
      showRequestError(enqueueSnackbar, message, error);
    }
  };

  const addFailed = (setter: typeof setFailedDetails, ids: number[]) =>
    setter((current) => new Set([...current, ...ids]));

  /**
   * One chunk of rows: their details (device/measurement counts, last
   * measurement) and alarm summary - /min stays light, the rest follows in
   * the background (useChunkedPreload), the rows on screen first.
   */
  const loadChunk = (ids: number[], generation: number) => {
    const current = () => generation === preload.generation();
    const details = new Promise<void>((resolve) => {
      void axiosConfig.perform_get(
        auth,
        `/v1/location/details/?ids=${ids.join(',')}&skip_lageplans=1`,
        (response) => {
          if (current()) {
            const loaded = (response?.data || []) as LocationRow[];
            setRows((prev) => mergeDetails(prev, loaded));
            const found = new Set(loaded.map((detail) => detail.id));
            const missing = ids.filter((id) => !found.has(id));
            if (missing.length) {
              addFailed(setFailedDetails, missing);
            }
          }
          resolve();
        },
        (error) => {
          if (current()) {
            addFailed(setFailedDetails, ids);
            showLoadError(t('locations_error_details'), error);
          }
          resolve();
        },
      );
    });
    const alarms = new Promise<void>((resolve) => {
      void axiosConfig.perform_get(
        auth,
        `/v1/alarm/location_summary/?ids=${ids.join(',')}`,
        (response) => {
          if (current()) {
            const payload = (response?.data?.locations || {}) as Record<string, LocationAlarmSummary>;
            setAlarmSummary((prev) => mergeAlarmSummary(prev, payload, ids));
          }
          resolve();
        },
        (error) => {
          if (current()) {
            addFailed(setFailedAlarms, ids);
            showLoadError(t('locations_error_alarm_summary'), error);
          }
          resolve();
        },
      );
    });
    return Promise.all([details, alarms]).then(() => undefined);
  };
  const preload = useChunkedPreload(loadChunk);

  useEffect(() => {
    fetchLocations(searchText, onlyConnected);
    // Per filter switch only: typing in the search filters the loaded rows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onlyConnected]);

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

  const sortedRows = useMemo(
    () =>
      sort
        ? sortLoadedFirst(
            filteredRows,
            (row) => sortValueOf(sort.id, row, alarmSummary[String(row.id)], t),
            sort.ascending,
          )
        : filteredRows,
    [filteredRows, sort, alarmSummary, t],
  );

  // The rows on screen go to the front of the loading queue - after a new
  // page, sort or search they don't wait for the rest of the list.
  const visibleIds = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage;
    return sortedRows.slice(start, start + rowsPerPage).map((row) => row.id);
  }, [sortedRows, currentPage, rowsPerPage]);
  const visibleKey = visibleIds.join(',');
  useEffect(() => {
    if (visibleIds.length) {
      preload.enqueue(visibleIds, true);
    }
    // Per set of visible rows (visibleKey), not per new array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleKey, preload.enqueue]);

  // How far the background loading is: rows with details (or given up).
  const preloaded = rows.filter((row) => row.measurement_count !== undefined || failedDetails.has(row.id)).length;

  // Staff: switched-off locations striped (grey), purgeable ones red.
  const { flagsOf } = useLocationFlags([
    ...rows.map((row) => row.id),
    ...(activeAlarms ?? []).map((row) => row.location.id),
  ]);

  const mobile = useIsMobile();
  // Phones: name and the compact state in the row, the rest in its expander.
  const { columns, expandable } = useMobileColumns(
    locationColumns({ alarmSummary, failedDetails, failedAlarms, flagsOf, mobile, t }),
    ['name', 'mobile-state'],
  );
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
            toFirstPage();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setSearchText('');
              toFirstPage();
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
              toFirstPage();
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
              {preloaded < rows.length && (
                <span className="locations-preload" data-testid="locations-preload">
                  <Spinner size="sm" animation="border" />
                  {t('locations_preload_progress', { done: preloaded, total: rows.length })}
                </span>
              )}
              {t('locations_count', { count: filteredRows.length, total: rows.length })}
            </span>
          )
        }
      >
        {/* Rows keep DataTable's own keyboard handling (Enter on a focused row). */}
        <div
          className={LOCATION_LIST_CLASS}
          onClick={untaggedRowClick(sortedRows, handleRowClick)}
          data-testid="locations-table"
        >
          <DataTable
            columns={columns}
            data={sortedRows}
            customStyles={progeoTableStyles}
            {...expandable}
            sortServer
            onSort={(column, direction) => {
              setSort({ id: String(column.id), ascending: direction === 'asc' });
              toFirstPage();
            }}
            pagination
            paginationResetDefaultPage={resetPage}
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
