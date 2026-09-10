import React, { useEffect, useMemo, useRef, useState } from 'react';
import DataTable from 'react-data-table-component';
import type { TableColumn } from 'react-data-table-component';
import { Button, Card, Form, Spinner } from 'react-bootstrap';
import { useSnackbar } from 'notistack';
import { useNavigate } from 'react-router';

import { useAuth } from '../../hooks/CoreAuthProvider';
import axiosConfig from '../axiosConfig';
import { showErrorBar } from '../components/ui/Snackbar.jsx';
import MeasurementSamplesCompareChart, {
  type MeasurementCompareRow,
} from '../components/device/MeasurementSamplesCompareChart.tsx';
import LocationEditModal, {
  type LocationEditRow,
} from '../components/modal/LocationEditModal.tsx';

type LocationRow = {
  id: number;
  name?: string | null;
  city?: string | null;
  address?: string | null;
  plz?: string | null;
  manager?: string | null;
  telefon?: string | null;
  mail?: string | null;
  project_id?: number | null;
  latitude?: number | null;
  longitude?: number | null;
  alarm_threshold?: number | null;
  device_count?: number;
  has_device?: boolean;
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

const LocationsOverview = () => {
  const auth = useAuth();
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
  const [selectedLocationId, setSelectedLocationId] = useState<number | null>(
    null,
  );
  const [selectedMeasurements, setSelectedMeasurements] = useState<
    MeasurementCompareRow[]
  >([]);
  const [measurementsLoading, setMeasurementsLoading] = useState(false);
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
    const params = new URLSearchParams();

    if (search.trim()) {
      params.set('search', search.trim());
    }

    if (hasDevice) {
      params.set('has_device', '1');
    }

    void axiosConfig.perform_get(
      auth,
      `/v1/location/min/?${params.toString()}`,
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
          navigate(`/location/${next[0].id}/detail/`);
        }
      },
      (error) => {
        const reason = error?.response?.data?.reason || error.message;
        showErrorBar(enqueueSnackbar, `Could not load locations: ${reason}`);
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
        setAlarmSummary((prev) => ({ ...prev, ...payload }));
      },
      (error) => {
        ids.forEach((id) => loadedAlarmIds.current.delete(id));
        const reason = error?.response?.data?.reason || error.message;
        showErrorBar(
          enqueueSnackbar,
          `Could not load alarm summary: ${reason}`,
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
      `/v1/location/details/?ids=${ids.join(',')}`,
      (response) => {
        const details = (response?.data || []) as LocationRow[];
        const detailsById = new Map(
          details.map((detail) => [detail.id, detail]),
        );
        setRows((prev) =>
          prev.map((row) => {
            const detail = detailsById.get(row.id);
            return detail ? { ...row, ...detail } : row;
          }),
        );
      },
      (error) => {
        // Allow a retry on the next page change instead of silently missing data.
        ids.forEach((id) => loadedDetailIds.current.delete(id));
        const reason = error?.response?.data?.reason || error.message;
        showErrorBar(
          enqueueSnackbar,
          `Could not load location details: ${reason}`,
        );
      },
    );
  };

  const handleRowClick = (row: LocationRow) => {
    navigate(`/location/${row.id}/detail/`);
  };

  const fetchLocationMeasurements = (locationId: number, year?: number) => {
    setMeasurementsLoading(true);
    const params = new URLSearchParams();
    if (year) {
      params.set('year', String(year));
    } else {
      params.set('limit', '300');
    }
    void axiosConfig.perform_get(
      auth,
      `/v1/location/${locationId}/measurements/?${params.toString()}`,
      (response) => {
        const measurements = (response?.data?.measurements ||
          []) as MeasurementCompareRow[];
        setSelectedMeasurements(measurements);
        setMeasurementsLoading(false);
      },
      (error) => {
        const reason = error?.response?.data?.reason || error.message;
        showErrorBar(
          enqueueSnackbar,
          `Could not load location measurements: ${reason}`,
        );
        setSelectedMeasurements([]);
        setMeasurementsLoading(false);
      },
    );
  };

  const handleCompareClick = (row: LocationRow) => {
    setSelectedLocationId(row.id);
    fetchLocationMeasurements(row.id);
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
    setRows((prev) =>
      prev.map((row) => {
        if (row.id !== updated.id) {
          return row;
        }
        return {
          ...row,
          ...updated,
          device_count: updated.device_count ?? row.device_count,
          has_device: updated.has_device ?? row.has_device,
        };
      }),
    );
    setShowEditModal(false);
    setEditingLocation(null);
  };

  const filteredRows = useMemo(() => {
    const needle = searchText.trim().toLowerCase();
    if (!needle) {
      return rows;
    }

    return rows.filter((row) => {
      const haystack = [
        row.name,
        row.city,
        row.address,
        row.plz,
        row.manager,
        row.telefon,
        row.mail,
        row.project_id,
      ]
        .filter((value) => value !== null && value !== undefined)
        .join(' ')
        .toLowerCase();

      return haystack.includes(needle);
    });
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

  // Row coloring priority: alarms (yellow) > measurements (green) > none (gray).
  const rowColorStyle = (row: LocationRow) => {
    const summary = alarmSummary[String(row.id)];
    if (summary && summary.count > 0) {
      return ROW_STYLES.alarm;
    }
    if ((row.measurement_count ?? 0) > 0 || row.last_measurement_at) {
      return ROW_STYLES.measurement;
    }
    return ROW_STYLES.none;
  };

  useEffect(() => {
    if (!selectedLocationId) {
      return;
    }

    const existsInFilteredRows = filteredRows.some(
      (row) => row.id === selectedLocationId,
    );
    if (!existsInFilteredRows) {
      setSelectedLocationId(null);
      setSelectedMeasurements([]);
    }
  }, [filteredRows, selectedLocationId]);

  const columns: TableColumn<LocationRow>[] = [
    {
      name: 'Project',
      selector: (row) => row.project_id ?? '-',
      sortable: true,
      width: '110px',
    },
    {
      name: 'Name',
      selector: (row) => row.name || '-',
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
      cell: (row) => {
        const summary = alarmSummary[String(row.id)];
        const hasAlarm = Boolean(summary && summary.count > 0);
        const hasMeasurements =
          (row.measurement_count ?? 0) > 0 || Boolean(row.last_measurement_at);
        return (
          <div className="d-flex align-items-center gap-2">
            <span
              className="d-inline-block rounded-circle"
              style={{
                width: 10,
                height: 10,
                backgroundColor: hasAlarm
                  ? '#fbbc15'
                  : hasMeasurements
                    ? '#8dc160'
                    : '#6c757d',
              }}
            />
            <span className="small">
              {hasAlarm
                ? `${summary.active}/${summary.count} active`
                : hasMeasurements
                  ? 'Measurements'
                  : 'No data'}
            </span>
          </div>
        );
      },
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
      width: '260px',
      cell: (row) => (
        <div className="d-flex gap-2">
          <Button
            size="sm"
            variant="outline-primary"
            title="Edit location"
            onClick={(event) => {
              event.stopPropagation();
              openEditModal(row);
            }}
          >
            <i className="bi bi-pencil"></i>
          </Button>
          <Button
            size="sm"
            variant="outline-danger"
            title="Open in Django admin for delete"
            href={`${import.meta.env.VITE_BACKEND_URL}/aadmin/progeo/progeolocation/${row.id}/delete/`}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(event) => event.stopPropagation()}
          >
            Delete
          </Button>
          <Button
            size="sm"
            variant="outline-warning"
            style={{
              display: !alarmSummary[String(row.id)]?.count
                ? 'none'
                : 'inline-block',
            }}
            title="View location alarms"
            onClick={(event) => {
              event.stopPropagation();
              navigate(`/location/${row.id}/alarms`);
            }}
          >
            Alarms
          </Button>
          <Button
            size="sm"
            variant="outline-secondary"
            title="Compare measurements of this location"
            onClick={(event) => {
              event.stopPropagation();
              handleCompareClick(row);
            }}
          >
            Compare
          </Button>
        </div>
      ),
    },
  ];

  const conditionalRowStyles = [
    {
      when: (row: LocationRow) => rowColorStyle(row) === ROW_STYLES.alarm,
      style: ROW_STYLES.alarm,
    },
    {
      when: (row: LocationRow) => rowColorStyle(row) === ROW_STYLES.measurement,
      style: ROW_STYLES.measurement,
    },
    {
      when: (row: LocationRow) => rowColorStyle(row) === ROW_STYLES.none,
      style: ROW_STYLES.none,
    },
    // Selected highlight last so it stays visible on colored rows.
    {
      when: (row: LocationRow) => row.id === selectedLocationId,
      style: {
        backgroundColor: 'rgba(13, 110, 253, 0.22)',
        borderLeft: '3px solid #0d6efd',
      },
    },
  ];

  return (
    <React.Fragment>
      <div className="d-flex flex-wrap mb-3 gap-3 align-items-center justify-content-between">
        <h2 className="mb-0">Locations Overview</h2>

        <div className="d-flex flex-wrap gap-3 align-items-center">
          <Form.Control
            type="text"
            placeholder="Search locations..."
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

      <div className="d-flex flex-wrap gap-3 small text-muted mb-2">
        <span className="d-flex align-items-center gap-1">
          <span
            className="d-inline-block rounded-circle"
            style={{ width: 10, height: 10, backgroundColor: '#fbbc15' }}
          />
          Alarms
        </span>
        <span className="d-flex align-items-center gap-1">
          <span
            className="d-inline-block rounded-circle"
            style={{ width: 10, height: 10, backgroundColor: '#8dc160' }}
          />
          Measurements
        </span>
        <span className="d-flex align-items-center gap-1">
          <span
            className="d-inline-block rounded-circle"
            style={{ width: 10, height: 10, backgroundColor: '#6c757d' }}
          />
          No data
        </span>
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

      <Card className="border-0 shadow-sm mt-3">
        <Card.Body>
          {measurementsLoading ? (
            <div className="d-flex align-items-center gap-2 text-muted">
              <Spinner size="sm" animation="border" />
              Loading location measurements...
            </div>
          ) : !selectedLocationId ? (
            <div className="text-muted">
              Click "Compare" on a row to display measurements from all devices
              connected to that location.
            </div>
          ) : selectedMeasurements.length === 0 ? (
            <div className="text-muted">
              No measurements found for devices in this location.
            </div>
          ) : (
            <MeasurementSamplesCompareChart
              rows={selectedMeasurements}
              onLoadCurrentYear={
                selectedLocationId
                  ? () =>
                      fetchLocationMeasurements(
                        selectedLocationId,
                        new Date().getFullYear(),
                      )
                  : null
              }
              isLoadingCurrentYear={measurementsLoading}
            />
          )}
        </Card.Body>
      </Card>

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
