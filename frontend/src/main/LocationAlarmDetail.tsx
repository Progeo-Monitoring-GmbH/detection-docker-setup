import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  Col,
  Container,
  Row,
  Spinner,
} from 'react-bootstrap';
import {
  ArrowLeft,
  Activity,
  Bell,
  Building,
  Geo,
  ThermometerHalf,
} from 'react-bootstrap-icons';
import { useSnackbar } from 'notistack';
import { useNavigate, useParams } from 'react-router';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig';
import { showErrorBar } from '../components/ui/Snackbar.jsx';
import AlarmMeasurementCompareChart from '../components/device/AlarmMeasurementCompareChart.tsx';
import SensorHeatmap2D from '../components/device/SensorHeatmap2D.tsx';
import { type SensorHeatmapResponse } from '../components/device/SensorHeatmap3D.tsx';
import AlarmTimeline, {
  alarmStartTime,
  formatDuration,
  isAlarmActive,
  parseTimestamp,
  type TimelineAlarm,
} from './AlarmTimeline.tsx';

type LocationDetail = {
  id?: number | null;
  project_id?: number | null;
  name?: string | null;
  address?: string | null;
  city?: string | null;
  plz?: string | null;
  manager?: string | null;
  mail?: string | null;
  telefon?: string | null;
  alarm_threshold?: number | null;
  latitude?: number | null;
  longitude?: number | null;
};

const HEATMAP_LIMIT = 300;
const TICK_MS = 30_000;

/** ms -> naive local ISO string (matches backend serializer output). */
const toLocalIso = (ms: number): string => {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
};

const STATUS_LABELS: Record<number, { label: string; variant: string }> = {
  0: { label: 'Neu', variant: 'warning' },
  1: { label: 'Quittiert', variant: 'secondary' },
  2: { label: 'Stoerung', variant: 'danger' },
};

const LocationAlarmDetail = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();

  const [location, setLocation] = useState<LocationDetail | null>(null);
  const [alarms, setAlarms] = useState<TimelineAlarm[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedAlarm, setSelectedAlarm] = useState<TimelineAlarm | null>(
    null,
  );
  const [heatmapLoading, setHeatmapLoading] = useState(false);
  const [heatmapResponse, setHeatmapResponse] =
    useState<SensorHeatmapResponse | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const hasActiveAlarm = useMemo(
    () => alarms.some((alarm) => isAlarmActive(alarm)),
    [alarms],
  );

  useEffect(() => {
    if (!hasActiveAlarm) {
      return undefined;
    }
    const intervalId = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(intervalId);
  }, [hasActiveAlarm]);

  const loadLocation = useCallback(() => {
    if (!id) {
      return;
    }
    void axiosConfig.perform_get(
      auth,
      `/v1/location/${id}/`,
      (response) => {
        setLocation((response?.data || null) as LocationDetail | null);
      },
      (error) => {
        const reason = error?.response?.data?.reason || error.message;
        showErrorBar(enqueueSnackbar, `Could not load location: ${reason}`);
      },
    );
  }, [auth, enqueueSnackbar, id]);

  const loadAlarms = useCallback(() => {
    if (!id) {
      return;
    }
    setLoading(true);
    void axiosConfig.perform_get(
      auth,
      `/v1/alarm/?location=${id}&days=365`,
      (response) => {
        setAlarms((response?.data?.alarms || []) as TimelineAlarm[]);
        setLoading(false);
      },
      (error) => {
        const reason = error?.response?.data?.reason || error.message;
        showErrorBar(enqueueSnackbar, `Could not load alarms: ${reason}`);
        setLoading(false);
      },
    );
  }, [auth, enqueueSnackbar, id]);

  useEffect(() => {
    setSelectedAlarm(null);
    setHeatmapResponse(null);
    loadLocation();
    loadAlarms();
  }, [loadLocation, loadAlarms]);

  const fetchHeatmap = useCallback(
    (alarm: TimelineAlarm) => {
      const locationId = alarm.location?.id ?? location?.id ?? id;
      if (locationId == null) {
        showErrorBar(
          enqueueSnackbar,
          'Alarm has no location to render a heatmap for.',
        );
        return;
      }

      const startMs = alarmStartTime(alarm);
      const normalizedMs = parseTimestamp(alarm.normalized_at);
      const endMs =
        normalizedMs != null
          ? normalizedMs
          : isAlarmActive(alarm)
            ? now
            : (startMs ?? now);
      const padMs = 5 * 60 * 1000;
      const fromMs = startMs != null ? startMs - padMs : now - padMs;
      const toMs = endMs + padMs;

      const params = new URLSearchParams({
        limit: String(HEATMAP_LIMIT),
        from: toLocalIso(fromMs),
        to: toLocalIso(toMs),
      });

      setSelectedAlarm(alarm);
      setHeatmapLoading(true);
      setHeatmapResponse(null);
      void axiosConfig.perform_get(
        auth,
        `/v1/location/${locationId}/heatmap/?${params.toString()}`,
        (result) => {
          setHeatmapResponse(
            (result?.data || null) as SensorHeatmapResponse | null,
          );
          setHeatmapLoading(false);
        },
        (error) => {
          const reason = error?.response?.data?.reason || error.message;
          showErrorBar(
            enqueueSnackbar,
            `Could not load alarm heatmap: ${reason}`,
          );
          setHeatmapResponse(null);
          setHeatmapLoading(false);
        },
      );
    },
    [auth, enqueueSnackbar, id, location?.id, now],
  );

  const alarmDuration = useCallback(
    (alarm: TimelineAlarm): number => {
      const startMs = alarmStartTime(alarm);
      if (startMs == null) {
        return 0;
      }
      const normalizedMs = parseTimestamp(alarm.normalized_at);
      const endMs =
        normalizedMs != null
          ? normalizedMs
          : isAlarmActive(alarm)
            ? now
            : startMs;
      return Math.max(0, (endMs - startMs) / 1000);
    },
    [now],
  );

  const locationLabel = location?.name
    ? `${location.name}${location.project_id != null ? ` (${location.project_id})` : ''}`
    : `Location ${id}`;

  return (
    <Container fluid className="py-4">
      <div className="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3">
        <div>
          <h2 className="mb-0">
            <Geo className="me-2 text-primary" />
            {locationLabel}
          </h2>
          <small className="text-muted">
            {alarms.length} alarm(s) for this location
          </small>
        </div>
        <Button
          variant="outline-secondary"
          onClick={() => navigate('/location/overview/')}
        >
          <ArrowLeft className="me-2" />
          Back to Locations
        </Button>
      </div>

      {/* Timeline */}
      <Card className="border-0 shadow-sm mb-3 p-2">
        <Card.Body>
          <div className="d-flex flex-wrap justify-content-between align-items-center mb-2 gap-2">
            <h5 className="mb-0">
              <Bell className="me-2 text-danger" />
              Alarm Timeline
            </h5>
            <small className="text-muted">
              Click a bar to load its heatmap
            </small>
          </div>
          {loading ? (
            <div className="d-flex align-items-center gap-2 text-muted py-5 justify-content-center">
              <Spinner size="sm" animation="border" />
              Loading alarms...
            </div>
          ) : (
            <AlarmTimeline
              alarms={alarms}
              now={now}
              selectedAlarmId={selectedAlarm?.id}
              onSelectAlarm={(alarm) => fetchHeatmap(alarm)}
            />
          )}
        </Card.Body>
      </Card>

      {/* Heatmap */}
      <Card className="border-0 shadow-sm mb-3 p-2">
        <Card.Body>
          <div className="d-flex flex-wrap justify-content-between align-items-center mb-2 gap-2">
            <h5 className="mb-0">
              <ThermometerHalf className="me-2 text-danger" />
              {selectedAlarm
                ? `Heatmap for Alarm #${selectedAlarm.id}`
                : 'Heatmap'}
            </h5>
            <small className="text-muted">
              Scoped to the selected alarm's active window
            </small>
          </div>
          {heatmapLoading ? (
            <div className="d-flex align-items-center gap-2 text-muted py-5 justify-content-center">
              <Spinner size="sm" animation="border" />
              Loading alarm heatmap...
            </div>
          ) : !selectedAlarm ? (
            <div className="text-muted py-5 text-center">
              Select an alarm to display its location heatmap.
            </div>
          ) : (
            <>
              <SensorHeatmap2D response={heatmapResponse} />
              <div className="d-flex flex-wrap justify-content-between align-items-center mb-2 gap-2">
                <h5 className="mb-0">
                  <Activity className="me-2 text-primary" />
                  Measurements
                </h5>
                <small className="text-muted">±6h around the alarm start</small>
              </div>
              {selectedAlarm ? (
                <AlarmMeasurementCompareChart alarm={selectedAlarm} />
              ) : (
                <div className="text-muted py-5 text-center">
                  Select an alarm to compare its measurements.
                </div>
              )}
            </>
          )}
        </Card.Body>
      </Card>

      {/* Details */}
      <Card className="border-0 shadow-sm p-2">
        <Card.Body>
          <h5 className="mb-3">
            <Building className="me-2 text-primary" />
            Alarm & Location Details
          </h5>
          <Row className="g-4">
            <Col md={6}>
              <h6 className="text-muted text-uppercase small mb-2">Location</h6>
              <dl className="row mb-0">
                <dt className="col-sm-4">Name</dt>
                <dd className="col-sm-8">{location?.name || '-'}</dd>
                <dt className="col-sm-4">Project</dt>
                <dd className="col-sm-8">{location?.project_id ?? '-'}</dd>
                <dt className="col-sm-4">Address</dt>
                <dd className="col-sm-8">
                  {[location?.address, location?.plz, location?.city]
                    .filter(Boolean)
                    .join(', ') || '-'}
                </dd>
                <dt className="col-sm-4">Manager</dt>
                <dd className="col-sm-8">{location?.manager || '-'}</dd>
                <dt className="col-sm-4">Mail</dt>
                <dd className="col-sm-8">{location?.mail || '-'}</dd>
                <dt className="col-sm-4">Phone</dt>
                <dd className="col-sm-8">{location?.telefon || '-'}</dd>
                <dt className="col-sm-4">Alarm Threshold</dt>
                <dd className="col-sm-8">{location?.alarm_threshold ?? '-'}</dd>
                <dt className="col-sm-4">Coordinates</dt>
                <dd className="col-sm-8">
                  {location?.latitude != null && location?.longitude != null
                    ? `${location.latitude.toFixed(5)}, ${location.longitude.toFixed(5)}`
                    : '-'}
                </dd>
              </dl>
            </Col>

            <Col md={6}>
              <h6 className="text-muted text-uppercase small mb-2">Alarm</h6>
              {!selectedAlarm ? (
                <div className="text-muted">
                  Select an alarm to see its details.
                </div>
              ) : (
                <dl className="row mb-0">
                  <dt className="col-sm-4">Alarm ID</dt>
                  <dd className="col-sm-8">#{selectedAlarm.id}</dd>
                  <dt className="col-sm-4">Device</dt>
                  <dd className="col-sm-8">
                    {selectedAlarm.device?.mac ||
                      selectedAlarm.device?.raw_hash ||
                      '-'}
                  </dd>
                  <dt className="col-sm-4">Sensors</dt>
                  <dd className="col-sm-8">
                    {(() => {
                      const pairs = Array.isArray(
                        selectedAlarm.sensor_max_values,
                      )
                        ? selectedAlarm.sensor_max_values
                        : [];
                      if (pairs.length === 0) {
                        return selectedAlarm.sensor_id != null
                          ? `#${selectedAlarm.sensor_id}`
                          : '-';
                      }
                      return pairs
                        .map(
                          (pair) =>
                            `#${pair.sensor_id ?? '-'} (${
                              pair.max_value ?? '-'
                            })`,
                        )
                        .join(', ');
                    })()}
                  </dd>
                  <dt className="col-sm-4">Threshold</dt>
                  <dd className="col-sm-8">{selectedAlarm.threshold ?? '-'}</dd>
                  <dt className="col-sm-4">Max Value</dt>
                  <dd className="col-sm-8">{selectedAlarm.max_value ?? '-'}</dd>
                  <dt className="col-sm-4">Triggered</dt>
                  <dd className="col-sm-8">
                    {selectedAlarm.triggered_at
                      ? new Date(
                          alarmStartTime(selectedAlarm) ?? Date.now(),
                        ).toLocaleString()
                      : '-'}
                  </dd>
                  <dt className="col-sm-4">Normalized</dt>
                  <dd className="col-sm-8">
                    {selectedAlarm.normalized_at
                      ? new Date(
                          parseTimestamp(selectedAlarm.normalized_at) ??
                            Date.now(),
                        ).toLocaleString()
                      : '-'}
                  </dd>
                  <dt className="col-sm-4">Active For</dt>
                  <dd className="col-sm-8">
                    {formatDuration(alarmDuration(selectedAlarm))}
                  </dd>
                  <dt className="col-sm-4">Status</dt>
                  <dd className="col-sm-8">
                    <div className="d-flex align-items-center gap-2">
                      <Badge
                        bg={isAlarmActive(selectedAlarm) ? 'danger' : 'success'}
                      >
                        {isAlarmActive(selectedAlarm) ? 'ACTIVE' : 'NORMALIZED'}
                      </Badge>
                      <Badge
                        bg={
                          (
                            STATUS_LABELS[selectedAlarm.status ?? 0] ||
                            STATUS_LABELS[0]
                          ).variant
                        }
                      >
                        {
                          (
                            STATUS_LABELS[selectedAlarm.status ?? 0] ||
                            STATUS_LABELS[0]
                          ).label
                        }
                      </Badge>
                    </div>
                  </dd>
                  {selectedAlarm.status === 1 && (
                    <>
                      <dt className="col-sm-4">Acknowledged By</dt>
                      <dd className="col-sm-8">
                        {selectedAlarm.evaluated_by?.username || 'unknown'}
                      </dd>
                      <dt className="col-sm-4">Acknowledged At</dt>
                      <dd className="col-sm-8">
                        {selectedAlarm.evaluated_at
                          ? new Date(
                              parseTimestamp(selectedAlarm.evaluated_at) ??
                                Date.now(),
                            ).toLocaleString()
                          : '-'}
                      </dd>
                    </>
                  )}
                </dl>
              )}
            </Col>
          </Row>
        </Card.Body>
      </Card>
    </Container>
  );
};

export default LocationAlarmDetail;
