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
import { ArrowLeft, Bell, Building, Geo } from 'react-bootstrap-icons';
import { useSnackbar } from 'notistack';
import { useNavigate, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig';
import { showRequestError } from '../components/ui/Snackbar.jsx';
import AlarmTimeline, {
  alarmKey,
  alarmStartTime,
  formatDuration,
  isAlarmActive,
  parseTimestamp,
  type TimelineAlarm,
} from './AlarmTimeline.tsx';
import type { RainEvent } from './alarmUtils';
import AlarmsOverview from './AlarmsOverview.tsx';
import { formatDate } from './dateFormat';

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

const TICK_MS = 30_000;

// ProgeoAlarm.Status -> i18n key and badge colour.
const STATUS_LABELS: Record<number, { labelKey: string; variant: string }> = {
  0: { labelKey: 'alarm_status_new', variant: 'warning' },
  1: { labelKey: 'alarm_status_acknowledged', variant: 'secondary' },
  2: { labelKey: 'alarm_status_fault', variant: 'danger' },
};

type LocationAlarmDetailProps = {
  /**
   * Location data shared by a parent view (LocationDetailView). When
   * `preloaded` is true the component never fetches the location itself and
   * just waits for this prop.
   */
  location?: LocationDetail | null;
  preloaded?: boolean;
};

const LocationAlarmDetail = ({
  location: sharedLocation,
  preloaded = false,
}: LocationAlarmDetailProps = {}) => {
  const { id } = useParams();
  const navigate = useNavigate();
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const { t } = useTranslation();

  const [location, setLocation] = useState<LocationDetail | null>(null);
  const [alarms, setAlarms] = useState<TimelineAlarm[]>([]);
  const [rainEvents, setRainEvents] = useState<RainEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedAlarm, setSelectedAlarm] = useState<TimelineAlarm | null>(
    null,
  );
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

  // Shared location from the parent wins; sync it into local state.
  useEffect(() => {
    if (sharedLocation) {
      setLocation(sharedLocation);
    }
  }, [sharedLocation]);

  const loadLocation = useCallback(() => {
    if (!id || preloaded) {
      return;
    }
    void axiosConfig.perform_get(
      auth,
      `/v1/location/${id}/`,
      (response) => {
        setLocation((response?.data || null) as LocationDetail | null);
      },
      (error) => {
        showRequestError(enqueueSnackbar, t('alarm_detail_load_location_failed'), error);
      },
    );
  }, [auth, enqueueSnackbar, id, preloaded, t]);

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
        setRainEvents((response?.data?.rain_events || []) as RainEvent[]);
        setLoading(false);
      },
      (error) => {
        showRequestError(enqueueSnackbar, t('alarm_detail_load_alarms_failed'), error);
        setLoading(false);
      },
    );
  }, [auth, enqueueSnackbar, id, t]);

  useEffect(() => {
    setSelectedAlarm(null);
    loadLocation();
    loadAlarms();
  }, [loadLocation, loadAlarms]);

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
    : t('alarm_detail_location_fallback', { id });

  return (
    <Container fluid className="py-4" data-testid="page-location-alarms">
      <div className="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3">
        <div>
          <h2 className="mb-0" data-testid="location-alarms-title">
            <Geo className="me-2 text-primary" />
            {locationLabel}
          </h2>
          <small className="text-muted" data-testid="location-alarms-count">
            {t('alarm_detail_count', { count: alarms.length })}
          </small>
        </div>
        <Button
          variant="outline-secondary"
          onClick={() => navigate('/location/overview/')}
          data-testid="location-alarms-back"
        >
          <ArrowLeft className="me-2" />
          {t('alarm_detail_back')}
        </Button>
      </div>

      {/* Timeline */}
      <Card className="border-0 shadow-sm mb-3 p-2" data-testid="location-alarms-timeline-card">
        <Card.Body>
          <div className="d-flex flex-wrap justify-content-between align-items-center mb-2 gap-2">
            <h5 className="mb-0">
              <Bell className="me-2 text-danger" />
              {t('alarm_detail_timeline')}
            </h5>
            <small className="text-muted">
              {t('alarm_detail_timeline_hint')}
            </small>
          </div>
          {loading ? (
            <div
              className="d-flex align-items-center gap-2 text-muted py-5 justify-content-center"
              data-testid="location-alarms-loading"
            >
              <Spinner size="sm" animation="border" />
              {t('alarm_detail_loading')}
            </div>
          ) : (
            <AlarmTimeline
              testId="location-alarms-timeline"
              alarms={alarms}
              rainEvents={rainEvents}
              now={now}
              selectedAlarmKey={selectedAlarm ? alarmKey(selectedAlarm) : null}
              onSelectAlarm={() => {}}
            />
          )}
        </Card.Body>
      </Card>

      {/* TODO: insert alarms as DataTable - there already is a component for it */}
      <AlarmsOverview testId="location-alarms-overview" />

      {/* Details */}
      <Card className="border-0 shadow-sm p-2" data-testid="location-alarms-details">
        <Card.Body>
          <h5 className="mb-3">
            <Building className="me-2 text-primary" />
            {t('alarm_detail_title')}
          </h5>
          <Row className="g-4">
            <Col md={6}>
              <h6 className="text-muted text-uppercase small mb-2">{t('alarm_detail_location')}</h6>
              <dl className="row mb-0" data-testid="location-alarms-location">
                <dt className="col-sm-4">{t('objekt_field_project_name')}</dt>
                <dd className="col-sm-8">{location?.name || '-'}</dd>
                <dt className="col-sm-4">{t('objekt_field_project_nr')}</dt>
                <dd className="col-sm-8">{location?.project_id ?? '-'}</dd>
                <dt className="col-sm-4">{t('alarm_field_address')}</dt>
                <dd className="col-sm-8">
                  {[location?.address, location?.plz, location?.city]
                    .filter(Boolean)
                    .join(', ') || '-'}
                </dd>
                <dt className="col-sm-4">{t('objekt_field_manager')}</dt>
                <dd className="col-sm-8">{location?.manager || '-'}</dd>
                <dt className="col-sm-4">{t('objekt_field_email')}</dt>
                <dd className="col-sm-8">{location?.mail || '-'}</dd>
                <dt className="col-sm-4">{t('objekt_field_phone')}</dt>
                <dd className="col-sm-8">{location?.telefon || '-'}</dd>
                <dt className="col-sm-4">{t('objekt_field_alarm_threshold')}</dt>
                <dd className="col-sm-8">{location?.alarm_threshold ?? '-'}</dd>
                <dt className="col-sm-4">{t('alarm_field_coordinates')}</dt>
                <dd className="col-sm-8">
                  {location?.latitude != null && location?.longitude != null
                    ? `${location.latitude.toFixed(5)}, ${location.longitude.toFixed(5)}`
                    : '-'}
                </dd>
              </dl>
            </Col>

            <Col md={6}>
              <h6 className="text-muted text-uppercase small mb-2">{t('alarm_detail_alarm')}</h6>
              {!selectedAlarm ? (
                <div className="text-muted" data-testid="location-alarms-select-hint">
                  {t('alarm_detail_select_hint')}
                </div>
              ) : (
                <dl className="row mb-0" data-testid="location-alarms-alarm">
                  <dt className="col-sm-4">{t('alarm_field_alarm_id')}</dt>
                  <dd className="col-sm-8" data-testid="location-alarms-alarm-id">#{selectedAlarm.id}</dd>
                  <dt className="col-sm-4">{t('alarm_field_device')}</dt>
                  <dd className="col-sm-8">
                    {selectedAlarm.device?.display_name ||
                      selectedAlarm.device?.raw_hash ||
                      '-'}
                  </dd>
                  <dt className="col-sm-4">{t('alarm_field_sensors')}</dt>
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
                  <dt className="col-sm-4">{t('alarm_field_threshold')}</dt>
                  <dd className="col-sm-8" data-testid="location-alarms-alarm-threshold">{selectedAlarm.threshold ?? '-'}</dd>
                  <dt className="col-sm-4">{t('alarm_field_max_value')}</dt>
                  <dd className="col-sm-8" data-testid="location-alarms-alarm-max-value">{selectedAlarm.max_value ?? '-'}</dd>
                  <dt className="col-sm-4">{t('alarm_field_triggered')}</dt>
                  <dd className="col-sm-8">
                    {selectedAlarm.triggered_at
                      ? formatDate(alarmStartTime(selectedAlarm))
                      : '-'}
                  </dd>
                  <dt className="col-sm-4">{t('alarm_field_normalized')}</dt>
                  <dd className="col-sm-8">
                    {selectedAlarm.normalized_at
                      ? formatDate(selectedAlarm.normalized_at)
                      : '-'}
                  </dd>
                  <dt className="col-sm-4">{t('alarm_field_active_for')}</dt>
                  <dd className="col-sm-8">
                    {formatDuration(alarmDuration(selectedAlarm))}
                  </dd>
                  <dt className="col-sm-4">{t('alarm_field_status')}</dt>
                  <dd className="col-sm-8">
                    <div className="d-flex align-items-center gap-2">
                      <Badge
                        bg={isAlarmActive(selectedAlarm) ? 'danger' : 'success'}
                        data-testid="location-alarms-alarm-state"
                      >
                        {isAlarmActive(selectedAlarm) ? t('alarm_state_active') : t('alarm_state_normalized')}
                      </Badge>
                      <Badge
                        bg={
                          (
                            STATUS_LABELS[selectedAlarm.status ?? 0] ||
                            STATUS_LABELS[0]
                          ).variant
                        }
                        data-testid="location-alarms-alarm-evaluation"
                      >
                        {t(
                          (
                            STATUS_LABELS[selectedAlarm.status ?? 0] ||
                            STATUS_LABELS[0]
                          ).labelKey,
                        )}
                      </Badge>
                    </div>
                  </dd>
                  {selectedAlarm.status === 1 && (
                    <>
                      <dt className="col-sm-4">{t('alarm_field_acknowledged_by')}</dt>
                      <dd className="col-sm-8">
                        {selectedAlarm.evaluated_by?.username || t('alarm_unknown_user')}
                      </dd>
                      <dt className="col-sm-4">{t('alarm_field_acknowledged_at')}</dt>
                      <dd className="col-sm-8">
                        {selectedAlarm.evaluated_at
                          ? formatDate(selectedAlarm.evaluated_at)
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
