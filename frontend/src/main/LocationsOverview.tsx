import React, { useEffect, useMemo, useRef, useState } from 'react';
import DataTable from 'react-data-table-component';
import type { TableColumn } from 'react-data-table-component';
import { Button, Form, Spinner } from 'react-bootstrap';
import { Pencil } from 'react-bootstrap-icons';
import { useSnackbar } from 'notistack';
import { useNavigate } from 'react-router';

import { useAuth } from '../../hooks/CoreAuthProvider';
import usePermissions from '../../hooks/usePermissions';
import axiosConfig from '../axiosConfig';
import { matchesLocationSearch } from '../components/location/locationSearch';
import { getBackendUrl } from '../backendUrl';
import { showRequestError } from '../components/ui/Snackbar.jsx';
import FavoriteStar from './FavoriteStar';
import LocationEditModal, {
  type LocationEditRow,
} from '../components/modal/LocationEditModal.tsx';

type LocationRow = LocationEditRow & {
  measurement_count?: number;
  last_measurement_at?: string | null;
};

type LocationAlarmSummary = {
  count: number;
  active: number;
};

/** Row coloring: yellow = has alarms, green = has measurements, gray = none. */
const ROW_STYLES = {
  alarm: {
    backgroundColor: 'rgba(251, 188, 21, 0.18)',
    borderLeft: '3px solid #fbbc15',
  },
  measurement: {
    backgroundColor: 'rgba(141, 193, 96, 0.18)',
    borderLeft: '3px solid #8dc160',
  },
  none: {
    backgroundColor: 'rgba(108, 117, 125, 0.10)',
    borderLeft: '3px solid #6c757d',
  },
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

type LocationState = keyof typeof ROW_STYLES;

/** Priority: alarms (yellow) > measurements (green) > none (gray). */
const locationState = (row: LocationRow, summary: LocationAlarmSummary | undefined): LocationState => {
  if (summary && summary.count > 0) {
    return 'alarm';
  }
  if ((row.measurement_count ?? 0) > 0 || row.last_measurement_at) {
    return 'measurement';
  }
  return 'none';
};

const STATE_DOT_COLORS: Record<LocationState, string> = {
  alarm: '#fbbc15',
  measurement: '#8dc160',
  none: '#6c757d',
};

/** The State column: a dot and "2/3 active" / "Measurements" / "No data";
 * a spinner until the alarm summary and the details are loaded. */
const LocationStateCell = ({
  row,
  summary,
}: {
  row: LocationRow;
  summary: LocationAlarmSummary | undefined;
}) => {
  if (!summary || row.measurement_count === undefined) {
    return (
      <div className="d-flex align-items-center gap-2 text-muted">
        <Spinner size="sm" animation="border" />
      </div>
    );
  }
  const state = locationState(row, summary);
  const labels: Record<LocationState, string> = {
    alarm: `${summary.active}/${summary.count} active`,
    measurement: 'Measurements',
    none: 'No data',
  };
  return (
    <div className="d-flex align-items-center gap-2">
      <span
        className="d-inline-block rounded-circle"
        style={{ width: 10, height: 10, backgroundColor: STATE_DOT_COLORS[state] }}
      />
      <span className="small">{labels[state]}</span>
    </div>
  );
};

/** The Actions column: edit, and delete (in the Django admin). */
const LocationActions = ({
  row,
  onEdit,
  canDelete,
}: {
  row: LocationRow;
  /** Null without the permission to edit. */
  onEdit: ((row: LocationRow) => void) | null;
  canDelete: boolean;
}) => (
  <div className="d-flex gap-2">
    {onEdit && (
      <Button
        size="sm"
        variant="outline-primary"
        title="Edit location"
        onClick={(event) => {
          event.stopPropagation();
          onEdit(row);
        }}
      >
        <Pencil />
      </Button>
    )}
    {canDelete && (
      <Button
        size="sm"
        variant="outline-danger"
        title="Open in Django admin for delete"
        href={getBackendUrl(`/aadmin/progeo/progeolocation/${row.id}/delete/`)}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(event) => event.stopPropagation()}
      >
        Delete
      </Button>
    )}
  </div>
);

/** Columns of the locations table. */
const locationColumns = ({
  alarmSummary,
  onEdit,
  canDelete,
}: {
  alarmSummary: Record<string, LocationAlarmSummary>;
  /** Null without the permission to edit. */
  onEdit: ((row: LocationRow) => void) | null;
  canDelete: boolean;
}): TableColumn<LocationRow>[] => [
  {
    name: 'Project',
    selector: (row) => row.project_id ?? '-',
    sortable: true,
    width: '110px',
  },
  {
    name: 'Name',
    selector: (row) => row.name || '-',
    // The star pins the location as favorite (staff only).
    cell: (row) => (
      <span className="d-flex align-items-center gap-2" style={{ minWidth: 0 }}>
        <FavoriteStar locationId={row.id} size={26} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.name || '-'}</span>
      </span>
    ),
    sortable: true,
    grow: 1.4,
  },
  {
    name: 'City',
    selector: (row) => row.city || '-',
    sortable: true,
    grow: 1.2,
  },
  {
    name: 'Address',
    selector: (row) => row.address || '-',
    grow: 1.7,
    sortable: true,
    wrap: true,
  },
  {
    name: 'Contact',
    selector: (row) => row.manager || row.telefon || row.mail || '-',
    sortable: true,
    grow: 1.5,
    wrap: true,
  },
  {
    name: 'State',
    cell: (row) => <LocationStateCell row={row} summary={alarmSummary[String(row.id)]} />,
    width: '150px',
  },
  {
    name: 'Devices',
    selector: (row) => row.device_count || 0,
    sortable: true,
    width: '120px',
  },
  {
    name: 'Actions',
    width: '300px',
    cell: (row) => (
      <LocationActions row={row} onEdit={onEdit} canDelete={canDelete} />
    ),
  },
];

/** Row colors by state (see locationState). */
const rowStylesFor = (alarmSummary: Record<string, LocationAlarmSummary>) =>
  (Object.keys(ROW_STYLES) as LocationState[]).map((state) => ({
    when: (row: LocationRow) => locationState(row, alarmSummary[String(row.id)]) === state,
    style: ROW_STYLES[state],
  }));

const LocationsOverview = () => {
  const auth = useAuth();
  const { hasPermission } = usePermissions();
  // Backend: PATCH /v1/location/{id}/ requires module_locations_edit.
  const canEdit = hasPermission('module_locations_edit');
  // Deleting goes through the Django admin, which needs a staff account on
  // top of the module permission.
  const canDelete =
    hasPermission('module_locations_delete') &&
    Boolean((auth?.user as { is_staff?: boolean } | null)?.is_staff);
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
        showRequestError(enqueueSnackbar, 'Could not load locations', error);
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
          'Could not load alarm summary',
          error,
        );
      },
    );
  };

  useEffect(() => {
    fetchLocations(searchText, onlyConnected);
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
          'Could not load location details',
          error,
        );
      },
    );
  };

  const handleRowClick = (row: LocationRow) => {
    navigate(`/location/${row.id}/status`);
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
  }, [filteredRows, currentPage, rowsPerPage]);

  const columns = locationColumns({
    alarmSummary,
    onEdit: canEdit ? openEditModal : null,
    canDelete,
  });
  const conditionalRowStyles = rowStylesFor(alarmSummary);

  return (
    <React.Fragment>
      <div className="d-flex flex-wrap mb-3 gap-3 align-items-center justify-content-between">
        <h2 className="mb-0">Locations Overview</h2>

        <div className="d-flex flex-wrap gap-3 align-items-center">
          <Form.Control
            type="text"
            placeholder="Search by name, address, postcode, city, project id…"
            value={searchText}
            onChange={(event) => {
              setSearchText(event.target.value);
              setCurrentPage(1);
            }}
            style={{ minWidth: '260px' }}
          />
          <Form.Check
            id="locations-only-connected"
            type="checkbox"
            label="Only locations with connected devices"
            checked={onlyConnected}
            onChange={(event) => setOnlyConnected(event.target.checked)}
          />
        </div>
      </div>

      <DataTable
        columns={columns}
        data={filteredRows}
        pagination
        paginationPerPage={rowsPerPage}
        onChangePage={(page) => setCurrentPage(page)}
        onChangeRowsPerPage={(newPerPage, page) => {
          setRowsPerPage(newPerPage);
          setCurrentPage(page);
        }}
        progressPending={loading}
        highlightOnHover
        pointerOnHover
        conditionalRowStyles={conditionalRowStyles}
        onRowClicked={handleRowClick}
        dense
      />

      <LocationEditModal
        show={showEditModal}
        location={editingLocation}
        onHide={closeEditModal}
        onSaved={handleLocationSaved}
      />
    </React.Fragment>
  );
};

export default LocationsOverview;
