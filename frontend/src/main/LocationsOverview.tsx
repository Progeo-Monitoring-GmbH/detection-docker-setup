import { useEffect, useMemo, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import DataTable from 'react-data-table-component';
import type { TableColumn } from 'react-data-table-component';
import { Alert, Button, Form, Spinner } from 'react-bootstrap';
import { Bell, Pencil, Search, XLg } from 'react-bootstrap-icons';
import { useSnackbar } from 'notistack';
import { useNavigate } from 'react-router';

import { useAuth } from '../../hooks/CoreAuthProvider';
import usePermissions from '../../hooks/usePermissions';
import axiosConfig from '../axiosConfig';
import { matchesLocationSearch } from '../components/location/locationSearch';
import { getBackendUrl } from '../backendUrl';
import { showRequestError } from '../components/ui/Snackbar.jsx';
import DeleteIconButton from '../components/ui/kit/DeleteIconButton';
import PanelCard from '../components/ui/kit/PanelCard';
import PillButton from '../components/ui/kit/PillButton';
import { progeoTableStyles } from '../components/ui/kit/SearchableDataTable';
import FavoriteStar from './FavoriteStar';
import LocationEditModal, {
  type LocationEditRow,
} from '../components/modal/LocationEditModal.tsx';
import { staffFlags } from './access';
import { formatDate } from './dateFormat';
import { repeatedTestId } from '../testIds';
import {
  LocationFlagIcons,
  locationOffRowStyle,
  useLocationFlags,
  type LocationFlags,
} from '../components/location/locationFlags';

import { untaggedRowClick } from './wholeRowClick';
import './LocationsOverview.css';

type FlagsOf = (id: number | null | undefined) => LocationFlags | null;

type LocationRow = LocationEditRow & {
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
      <div className="small" {...repeatedTestId('locations-active-alarm', row.id)}>
        <LocationFlagIcons flags={flagsOf(row.location.id)} testKey={`active-alarm-${row.id}`} />
        {row.location.name || '-'}
        {row.location.city && (
          <div className="text-muted">{row.location.city}</div>
        )}
      </div>
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
 * Row colouring by state (classes in LocationsOverview.css): ProGeo orange =
 * has alarms, green = has measurements, grey = none.
 */
const ROW_CLASSES = {
  alarm: 'locations-row--alarm',
  measurement: 'locations-row--measurement',
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

/** Rows with an edited location merged in (counts it didn't send kept). */
const mergeSaved = (rows: LocationRow[], updated: LocationEditRow) =>
  rows.map((row) =>
    row.id === updated.id
      ? {
          ...row,
          ...updated,
          device_count: updated.device_count ?? row.device_count,
          has_device: updated.has_device ?? row.has_device,
        }
      : row,
  );

type LocationState = keyof typeof ROW_CLASSES;

/** Priority: alarms (orange) > measurements (green) > none (gray). */
const locationState = (row: LocationRow, summary: LocationAlarmSummary | undefined): LocationState => {
  if (summary && summary.count > 0) {
    return 'alarm';
  }
  if ((row.measurement_count ?? 0) > 0 || row.last_measurement_at) {
    return 'measurement';
  }
  return 'none';
};

/** The State column: a dot and "2/3 active" / "Measurements" / "No data";
 * a spinner until the alarm summary and the details are loaded. */
const LocationStateCell = ({
  row,
  summary,
  t,
}: {
  row: LocationRow;
  summary: LocationAlarmSummary | undefined;
  t: TFn;
}) => {
  if (!summary || row.measurement_count === undefined) {
    return (
      <div className="d-flex align-items-center gap-2 text-muted" {...repeatedTestId('locations-state-loading', row.id)}>
        <Spinner size="sm" animation="border" />
      </div>
    );
  }
  const state = locationState(row, summary);
  const labels: Record<LocationState, string> = {
    alarm: t('locations_state_active', { active: summary.active, count: summary.count }),
    measurement: t('locations_state_measurements'),
    none: t('locations_state_no_data'),
  };
  return (
    <div className="d-flex align-items-center gap-2" {...repeatedTestId('locations-state', row.id)}>
      <span className={`d-inline-block rounded-circle locations-state-dot locations-state-dot--${state}`} />
      <span className="small">{labels[state]}</span>
    </div>
  );
};

/** The Actions column: edit, and delete (in the Django admin). */
const LocationActions = ({
  row,
  onEdit,
  canDelete,
  t,
}: {
  row: LocationRow;
  /** Null without the permission to edit. */
  onEdit: ((row: LocationRow) => void) | null;
  canDelete: boolean;
  t: TFn;
}) => (
  <div className="d-flex gap-2">
    {onEdit && (
      <Button
        size="sm"
        variant="outline-primary"
        title={t('locations_edit')}
        aria-label={t('locations_edit')}
        {...repeatedTestId('locations-edit', row.id)}
        onClick={(event) => {
          event.stopPropagation();
          onEdit(row);
        }}
      >
        <Pencil />
      </Button>
    )}
    {canDelete && (
      <DeleteIconButton
        label={t('locations_delete_admin')}
        href={getBackendUrl(`/aadmin/progeo/progeolocation/${row.id}/delete/`)}
        target="_blank"
        onClick={(event) => event.stopPropagation()}
        testId="locations-delete"
        testKey={row.id}
      />
    )}
  </div>
);

/** Columns of the locations table. */
const locationColumns = ({
  alarmSummary,
  onEdit,
  canDelete,
  flagsOf,
  t,
}: {
  alarmSummary: Record<string, LocationAlarmSummary>;
  /** Null without the permission to edit. */
  onEdit: ((row: LocationRow) => void) | null;
  canDelete: boolean;
  /** Staff: the switched-off flags (locationFlags.tsx) - null for everyone else. */
  flagsOf: FlagsOf;
  t: TFn;
}): TableColumn<LocationRow>[] => [
  {
    name: t('locations_col_project'),
    selector: (row) => row.project_id ?? '-',
    sortable: true,
    width: '110px',
  },
  {
    name: t('locations_col_name'),
    selector: (row) => row.name || '-',
    // The star pins the location as favorite.
    cell: (row) => (
      <span className="d-flex align-items-center gap-2 locations-name-cell" {...repeatedTestId('locations-row', row.id)}>
        <FavoriteStar locationId={row.id} size={26} />
        <span className="locations-name-text">
          <LocationFlagIcons flags={flagsOf(row.id)} testKey={`location-${row.id}`} />
          {row.name || '-'}
        </span>
      </span>
    ),
    sortable: true,
    grow: 1.4,
  },
  {
    name: t('locations_col_city'),
    selector: (row) => row.city || '-',
    sortable: true,
    grow: 1.2,
  },
  {
    name: t('locations_col_address'),
    selector: (row) => row.address || '-',
    grow: 1.7,
    sortable: true,
    wrap: true,
  },
  {
    name: t('locations_col_contact'),
    selector: (row) => row.manager || row.telefon || row.mail || '-',
    sortable: true,
    grow: 1.5,
    wrap: true,
  },
  {
    name: t('locations_col_state'),
    cell: (row) => <LocationStateCell row={row} summary={alarmSummary[String(row.id)]} t={t} />,
    width: '150px',
  },
  {
    name: t('locations_col_devices'),
    selector: (row) => row.device_count || 0,
    sortable: true,
    width: '120px',
  },
  {
    name: t('locations_col_actions'),
    width: '120px',
    cell: (row) => (
      <LocationActions row={row} onEdit={onEdit} canDelete={canDelete} t={t} />
    ),
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
  // Backend: PATCH /v1/location/{id}/ requires module_locations_edit.
  const canEdit = hasPermission('module_locations_edit');
  // Deleting goes through the Django admin, which needs a staff account on
  // top of the module permission.
  const canDelete =
    hasPermission('module_locations_delete') && staffFlags(auth?.user).isStaff;
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
  const [showEditModal, setShowEditModal] = useState(false);
  const [editingLocation, setEditingLocation] = useState<LocationRow | null>(
    null,
  );
  const [currentPage, setCurrentPage] = useState(1);
  const [rowsPerPage, setRowsPerPage] = useState(10);
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

  const openEditModal = (row: LocationRow) => {
    setEditingLocation(row);
    setShowEditModal(true);
  };

  const closeEditModal = () => {
    setShowEditModal(false);
    setEditingLocation(null);
  };

  const handleLocationSaved = (updated: LocationEditRow) => {
    setRows((prev) => mergeSaved(prev, updated));
    setShowEditModal(false);
    setEditingLocation(null);
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

  // Staff: switched-off locations (notifications off / marked purgeable) striped.
  const { flagsOf, isOff } = useLocationFlags([
    ...rows.map((row) => row.id),
    ...(activeAlarms ?? []).map((row) => row.location.id),
  ]);

  const columns = locationColumns({
    alarmSummary,
    onEdit: canEdit ? openEditModal : null,
    canDelete,
    flagsOf,
    t,
  });
  // The switched-off stripes first: the table keeps the style of the last
  // matching rule, so the state colour stays (locationOffRowStyle).
  const conditionalRowStyles = [
    locationOffRowStyle((row: LocationRow) => isOff(row.id)),
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
            <div onClick={untaggedRowClick(activeAlarms, openAlarmRow)}>
              <DataTable
                columns={activeAlarmColumnsFor(flagsOf, t)}
                data={activeAlarms}
                customStyles={progeoTableStyles}
                conditionalRowStyles={[locationOffRowStyle((row: ActiveAlarm) => isOff(row.location.id))]}
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

      <PanelCard
        testId="locations-list"
        title={
          <span className="locations-list-title">
            {t('locations_list_title')}
            {!loading && (
              <span className="locations-list-count" data-testid="locations-count">
                {t('locations_count', { count: filteredRows.length, total: rows.length })}
              </span>
            )}
          </span>
        }
        actions={filters}
      >
        {/* Rows keep DataTable's own keyboard handling (Enter on a focused row). */}
        <div onClick={untaggedRowClick(filteredRows, handleRowClick)} data-testid="locations-table">
          <DataTable
            columns={columns}
            data={filteredRows}
            customStyles={progeoTableStyles}
            pagination
            paginationPerPage={rowsPerPage}
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
            dense
          />
        </div>
      </PanelCard>

      <LocationEditModal
        show={showEditModal}
        location={editingLocation}
        onHide={closeEditModal}
        onSaved={handleLocationSaved}
      />
    </div>
  );
};

export default LocationsOverview;
