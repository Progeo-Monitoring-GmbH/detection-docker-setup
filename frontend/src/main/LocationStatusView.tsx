import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Form, Spinner } from 'react-bootstrap';
import { useSnackbar } from 'notistack';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig';
import {
  errorReason,
  showErrorBar,
  showSuccessBar,
} from '../components/ui/Snackbar.jsx';
import { framesOf, seriesOf } from '../components/device/heatmapData';
import {
  defaultStepForRange,
  stepsForRange,
} from '../components/device/heatmapSteps';
import KpiStrip from '../components/ui/kit/KpiStrip';
import SegmentedControl from '../components/ui/kit/SegmentedControl';
import PillSelect from '../components/ui/kit/PillSelect';
import type { LocationDetail } from './locationTypes';
import type { HeatProfile } from '../components/device/sensorHeatmapTypes';
import { isLorawanProject, planVisualization, showsSensorTable } from './projectType';
import LocationClimatePanels from './LocationClimatePanels';
import LocationBatteryVoltagePanel from './LocationBatteryVoltagePanel';
import LocationPlanPanel from './LocationPlanPanel';
import VerdachtsstellenPanel from './VerdachtsstellenPanel';
import {
  availableTimeRanges,
  effectiveTimeRange,
  TIME_RANGE_DAYS,
  timeRangeCandidates,
  timeRangeLabelKey,
  type TimeRange,
} from './timeRanges';
import {
  alarmSpansOf,
  anlageStatusOf,
  type AnlageState,
  formatMinutes,
  highestOf,
  historySpecFor,
  measurePointMeters,
  nextMeasurementOf,
  severityColor,
  worstSeverityOf,
  type VerdachtsstelleCluster,
} from './locationStatusData';
import { zeitreiheSensorsOf } from './zeitreiheSensors';
import ZeitreihePanel from './ZeitreihePanel';
import { useAlarmClusters } from './useAlarmClusters';
import { useLocationHistory } from './useLocationHistory';
import { useMeasurementRangeState } from './useMeasurementRange';
import { isDemoUser } from './demo';
import { formatDate, formatRelativeTime } from './dateFormat';
import { staffFlags } from './access';
import './LocationStatusView.css';

type LocationStatusViewProps = {
  location: LocationDetail | null;
  locationId: number;
  /** Public demo view: reads /v1/demo/... and offers no write actions. */
  demo?: boolean;
};

// Points per Zeitreihe range at most (30 days hourly), each the highest
// value of its part of the range.
const ZEITREIHE_LIMIT = 720;
const DAY_MS = 24 * 60 * 60 * 1000;

const formatSpanTime = (ms: number) => formatDate(ms, 'dayMonthTime');

const Loading = () => {
  const { t } = useTranslation();
  return (
    <div className="d-flex justify-content-center py-5 text-muted" data-testid="status-loading">
      <Spinner animation="border" className="me-2" /> {t('ui_loading')}
    </div>
  );
};

/** A device that can be asked for a measurement (GET
 * /v1/location/<pk>/request-measurement/devices/). Only devices with a
 * chip_id are offered - the backend refuses the others. */
type RequestableDevice = {
  id: number;
  display_name: string | null;
  /** The full name: custom name · model · hash (device_overview.device_label). */
  label?: string | null;
  chip_id: string | null;
  device_ip: string | null;
};

/** "Request measurement" (the location's name and address are in the portal's title). */
const LocationStatusHeader = ({
  locationId,
  canRequestMeasurement,
}: {
  locationId: number;
  canRequestMeasurement: boolean;
}) => {
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const { t } = useTranslation();
  const [requesting, setRequesting] = useState(false);
  // Several devices can belong to one location - the request names one.
  const [devices, setDevices] = useState<RequestableDevice[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<number | null>(null);
  // Answers of an older location are dropped.
  const deviceRequest = useRef(0);

  useEffect(() => {
    if (!canRequestMeasurement) {
      deviceRequest.current += 1;
      setDevices([]);
      setSelectedDeviceId(null);
      return;
    }
    const request = ++deviceRequest.current;
    void axiosConfig.perform_get(
      auth,
      `/v1/location/${locationId}/request-measurement/devices/`,
      (response) => {
        if (request !== deviceRequest.current) {
          return;
        }
        // A measurement can only be requested from a device that identifies
        // itself (chip_id) and that has an address to reach (device_ip).
        const list = ((response?.data?.devices ?? []) as RequestableDevice[]).filter(
          (device) => Boolean(device.chip_id) && Boolean(device.device_ip),
        );
        setDevices(list);
        setSelectedDeviceId(list.length ? list[0].id : null);
      },
      () => {
        if (request !== deviceRequest.current) {
          return;
        }
        // No devices to ask: the button stays hidden.
        setDevices([]);
        setSelectedDeviceId(null);
      },
    );
    // Once per location - auth changes with the path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canRequestMeasurement, locationId]);

  const requestMeasurement = () => {
    if (selectedDeviceId == null) {
      return;
    }
    setRequesting(true);
    void axiosConfig.perform_post(
      auth,
      `/v1/location/${locationId}/request-measurement/`,
      { device: selectedDeviceId },
      (response) => {
        showSuccessBar(
          enqueueSnackbar,
          t('status_request_measurement_sent', {
            count: response?.data?.requested_devices ?? 1,
          }),
        );
        setRequesting(false);
      },
      (error) => {
        const reason = errorReason(error);
        showErrorBar(
          enqueueSnackbar,
          t('status_request_measurement_error', { reason }),
        );
        setRequesting(false);
      },
    );
  };

  // Name, project, product and address are in the portal's title
  // (LocationPortalLayout) - here only "request measurement".
  if (!canRequestMeasurement || devices.length === 0) {
    return null;
  }

  return (
    <div className="status-header" data-testid="status-header">
      {canRequestMeasurement && devices.length > 0 && (
        <div className="status-request" data-testid="status-request">
          {devices.length > 1 && (
            <Form.Select
              data-testid="status-request-device"
              aria-label={t('status_request_measurement_device')}
              title={t('status_request_measurement_device')}
              value={selectedDeviceId ?? ''}
              onChange={(event) => setSelectedDeviceId(Number(event.target.value))}
              disabled={requesting}
              className="status-request-device"
            >
              {devices.map((device) => (
                <option key={device.id} value={device.id}>
                  {device.label || device.display_name || device.chip_id || `#${device.id}`}
                </option>
              ))}
            </Form.Select>
          )}
          <button
            type="button"
            onClick={requestMeasurement}
            data-testid="status-request-measurement"
            disabled={requesting || selectedDeviceId == null}
            className={`status-request-button${requesting ? ' status-request-button--requesting' : ''}`}
          >
            {requesting && <Spinner size="sm" animation="border" />}
            {t('status_request_measurement')}
          </button>
        </div>
      )}
    </div>
  );
};

/** Object status, open Verdachtsstellen, highest reading and whether the
 * installation reports (a measurement in the last 24 h) - with the time
 * since its newest measurement. */
const StatusKpis = ({
  clusters,
  threshold,
  anlage,
  now,
}: {
  clusters: VerdachtsstelleCluster[];
  threshold: number | null;
  anlage: { state: AnlageState; last: number | null; next: number | null };
  now: number;
}) => {
  const { t } = useTranslation();
  // The Anlage tile counts down to the next measurement: its own clock,
  // so the rest of the page doesn't re-render every 30 s.
  const [clock, setClock] = useState(() => Date.now());
  const ticking = anlage.state === 'online' && anlage.next != null;
  useEffect(() => {
    if (!ticking) {
      return undefined;
    }
    const timer = window.setInterval(() => setClock(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [ticking]);
  const tileNow = Math.max(now, clock);
  const upcoming = anlage.state === 'online' ? nextMeasurementOf(anlage.next, tileNow) : null;
  const anlageNote = [
    anlage.last != null
      ? t('status_kpi_anlage_last', { time: formatRelativeTime(anlage.last, tileNow) })
      : t('status_kpi_anlage_last_unknown'),
    upcoming &&
      (upcoming.overdue
        ? t('status_kpi_anlage_next_overdue', { time: formatMinutes(upcoming.minutes) })
        : t('status_kpi_anlage_next', { time: formatMinutes(upcoming.minutes) })),
  ]
    .filter(Boolean)
    .join(' · ');
  const openClusters = clusters.filter((cluster) => cluster.state !== 'geloest');
  const worstSeverity = worstSeverityOf(openClusters);
  const highestReading = highestOf(clusters.map((cluster) => cluster.max_value));

  return (
    <KpiStrip
      testId="status-kpis"
      tiles={[
        {
          testId: 'status-kpi-objektstatus',
          label: t('status_kpi_objektstatus'),
          value: worstSeverity
            ? t(`ui_severity_${worstSeverity}` as const)
            : t('status_kpi_ok'),
          note: openClusters.length
            ? t('status_kpi_note_open', { count: openClusters.length })
            : t('status_kpi_note_none'),
          valueColor: severityColor(worstSeverity),
        },
        {
          testId: 'status-kpi-verdachtsstellen',
          label: t('status_kpi_verdachtsstellen'),
          value: String(openClusters.length),
          unit: t('status_kpi_active_unit'),
        },
        {
          testId: 'status-kpi-max-value',
          label: t('status_kpi_max_value'),
          value:
            highestReading != null ? String(Math.round(highestReading)) : '–',
          unit: highestReading != null ? 'mV' : undefined,
          note:
            threshold != null
              ? t('status_kpi_max_value_threshold', { threshold })
              : undefined,
        },
        {
          testId: 'status-kpi-anlage',
          label: t('status_kpi_anlage'),
          value:
            anlage.state === 'loading'
              ? '–'
              : t(`status_kpi_anlage_${anlage.state}` as const),
          note: anlage.state === 'loading' ? undefined : anlageNote,
          valueColor:
            anlage.state === 'online' ? '#3F7A1C' : anlage.state === 'offline' ? '#C44D26' : '#8B8383',
        },
      ]}
    />
  );
};


const LocationStatusView = ({
  location,
  locationId,
  demo = false,
}: LocationStatusViewProps) => {
  const auth = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation();
  // The demo user sees the regular portal, but no actions with real side
  // effects (a measurement request reaches the devices).
  const readOnlyDemo = demo || isDemoUser(auth.user);
  // Battery charts are device maintenance - staff (and superusers) only.
  const isStaff = !demo && staffFlags(auth?.user).isStaffOrSuperuser;

  const [statusView, setStatusView] = useState<'roof' | 'zeitreihe'>('roof');
  // The range of both views - the plan's frames and the Zeitreihe.
  const [selectedRange, setSelectedRange] = useState<TimeRange>('7d');
  // Step of the plan's frames, picked in its dropdown; null: the range's default.
  const [pickedStep, setPickedStep] = useState<number | null>(null);
  // "Now" until the data arrives (the parent remounts per location).
  const [openedAt] = useState(() => Date.now());

  // LoRaWAN objects have no samples (no heatmap, no Verdachtsstellen) - they
  // show humidity/temperature charts instead, see LocationClimatePanels.
  const isLorawan = isLorawanProject(location?.project_type);

  // The history to load, and the long Zeitreihe ranges once the data
  // reaches that far back (LoRaWAN: LocationClimatePanels does its own).
  const { range: measurementRange, failed: measurementRangeFailed } = useMeasurementRangeState(
    locationId,
    demo,
    !isLorawan,
  );
  const rangeOptions = useMemo(
    () => availableTimeRanges(measurementRange, timeRangeCandidates({ long: true, staff: isStaff })),
    [isStaff, measurementRange],
  );
  const range = effectiveTimeRange(selectedRange, rangeOptions);
  const rangeDays = TIME_RANGE_DAYS[range];

  const historySpec = useMemo(
    () => (isLorawan ? null : historySpecFor(measurementRange, measurementRangeFailed, openedAt)),
    [isLorawan, measurementRange, measurementRangeFailed, openedAt],
  );
  const {
    history,
    loadedAt: historyLoadedAt,
    loading: historyLoading,
    denied: historyDenied,
  } = useLocationHistory(locationId, demo, historySpec);
  // Staff: the plan's heat as another value per sensor (WP, EP, WP + EP) -
  // its own history, only for the heatmap; the Zeitreihe, the KPIs and the
  // sensor table keep |WP - EP| (the alarm value).
  const [heatProfile, setHeatProfile] = useState<HeatProfile>('diff');
  const profileHistory = useLocationHistory(
    locationId,
    demo,
    heatProfile === 'diff' ? null : historySpec,
    heatProfile,
  );
  const {
    clusters,
    loading: clustersLoading,
    denied: clustersDenied,
    loadedAt: clustersLoadedAt,
    acknowledging,
    acknowledge,
  } = useAlarmClusters(locationId, demo, !isLorawan);

  // The step of the loaded history: the plan's steps must be multiples.
  const baseStep = history?.step ?? historySpec?.step ?? null;
  const stepOptions = useMemo(() => stepsForRange(rangeDays, baseStep), [rangeDays, baseStep]);
  const heatmapStep =
    pickedStep != null && stepOptions.some((step) => step.seconds === pickedStep)
      ? pickedStep
      : defaultStepForRange(rangeDays, baseStep);

  // The range (the last N days up to when the history arrived), for the
  // plan's frames and the Zeitreihe - cut out of the history, no request.
  const now = historyLoadedAt ?? openedAt;
  const heatmap = useMemo(
    () => framesOf(history, { from: now - rangeDays * DAY_MS, to: now, step: heatmapStep }),
    [history, now, rangeDays, heatmapStep],
  );
  // While the picked profile loads, the heat keeps |WP - EP|.
  const profileHistoryShown = heatProfile !== 'diff' && profileHistory.history ? profileHistory.history : null;
  const profileHeatmap = useMemo(
    () =>
      profileHistoryShown
        ? framesOf(profileHistoryShown, { from: now - rangeDays * DAY_MS, to: now, step: heatmapStep })
        : null,
    [profileHistoryShown, now, rangeDays, heatmapStep],
  );
  const zeitreihe = useMemo(
    () => seriesOf(history, now - rangeDays * DAY_MS, now, ZEITREIHE_LIMIT, baseStep ?? 30 * 60),
    [baseStep, history, now, rangeDays],
  );

  const thresholdValue = location?.alarm_threshold ?? null;
  const sensorPoints = useMemo(() => history?.sensor_points ?? [], [history]);
  // The placed ProgeoMeasurePoint of a sensor, if any: its name and own
  // threshold override win over the generic label/object default.
  const measurePointOf = useCallback(
    (sensorId: number) => sensorPoints.find((point) => point.pos === sensorId),
    [sensorPoints],
  );
  const sensorLabel = useCallback(
    (sensorId: number) =>
      measurePointOf(sensorId)?.name ||
      t('status_sensor_label', { sensor: sensorId }),
    [measurePointOf, t],
  );
  const metersOf = useCallback(
    (sensorId: number) => measurePointMeters(measurePointOf(sensorId)),
    [measurePointOf],
  );

  // Zeitreihe ("Letzte 24 h" ... "Letzte 3 Jahre", see timeRanges.ts): the
  // measured value of every sensor over the range, cut out of the loaded
  // history like the heatmap's frames - classified for ZeitreihePanel.
  const zeitreiheSensors = useMemo(
    () =>
      zeitreiheSensorsOf(
        zeitreihe,
        sensorLabel,
        (sensorId) => measurePointOf(sensorId)?.threshold ?? thresholdValue,
      ),
    [measurePointOf, sensorLabel, thresholdValue, zeitreihe],
  );

  const alarmSpans = useMemo(
    () =>
      alarmSpansOf(clusters, clustersLoadedAt ?? openedAt, (cluster, from, to) =>
        to == null
          ? t('status_alarm_span_active', {
              sensor: sensorLabel(cluster.sensor_id),
              from: formatSpanTime(from),
            })
          : t('status_alarm_span', {
              sensor: sensorLabel(cluster.sensor_id),
              from: formatSpanTime(from),
              to: formatSpanTime(to),
            }),
      ),
    [clusters, clustersLoadedAt, openedAt, sensorLabel, t],
  );

  return (
    <div className="status-view" data-testid="page-location-status">
      <LocationStatusHeader
        locationId={locationId}
        canRequestMeasurement={!isLorawan && !readOnlyDemo}
      />

      {isLorawan ? (
        <LocationClimatePanels locationId={locationId} demo={demo} showBattery={isStaff} />
      ) : (
        <>
          {clustersLoading || historyLoading ? (
            <Loading />
          ) : (
            !clustersDenied && (
              <StatusKpis
                clusters={clusters}
                threshold={thresholdValue}
                anlage={anlageStatusOf(measurementRange, measurementRangeFailed, now)}
                now={now}
              />
            )
          )}

          <div className="status-switches" data-testid="status-switches">
            <SegmentedControl
              testId="status-view-switch"
              options={[
                { value: 'roof', label: t('status_view_roof') },
                { value: 'zeitreihe', label: t('status_view_zeitreihe') },
              ]}
              value={statusView}
              onChange={(value) => setStatusView(value as 'roof' | 'zeitreihe')}
            />
            <SegmentedControl
              testId="status-range"
              options={rangeOptions.map((value) => ({
                value,
                label: t(timeRangeLabelKey(value)),
              }))}
              value={range}
              onChange={(value) => {
                setSelectedRange(value as TimeRange);
                setPickedStep(null);
              }}
            />
            {statusView === 'roof' && stepOptions.length > 1 && (
              <PillSelect
                testId="status-step"
                label={t('heatmap_step_label')}
                title={t('heatmap_step_hint')}
                options={stepOptions.map((step) => ({
                  value: String(step.seconds),
                  label: t(`heatmap_step_${step.key}`),
                }))}
                value={String(heatmapStep)}
                onChange={(value) => setPickedStep(Number(value))}
              />
            )}
          </div>

          {statusView === 'zeitreihe' ? (
            <>
              <ZeitreihePanel loading={historyLoading} sensors={zeitreiheSensors} />
              {isStaff && (
                <LocationBatteryVoltagePanel
                  locationId={locationId}
                  days={rangeDays}
                  demo={demo}
                />
              )}
            </>
          ) : (
            <div className="status-columns" data-testid="status-roof">
              <div className="status-column-plan">
                <LocationPlanPanel
                  heatmap={heatmap}
                  visualization={planVisualization(location?.project_type)}
                  withSensorTable={showsSensorTable(location?.project_type)}
                  threshold={thresholdValue}
                  denied={historyDenied}
                  alarmSpans={alarmSpans}
                  profileHeatmap={profileHeatmap}
                  profile={heatProfile}
                  onProfileChange={setHeatProfile}
                  profileLoading={heatProfile !== 'diff' && profileHistory.loading}
                />
              </div>
              <div className="status-column-side">
                <VerdachtsstellenPanel
                  clusters={clusters}
                  denied={clustersDenied}
                  sensorLabel={sensorLabel}
                  metersOf={metersOf}
                  acknowledging={acknowledging}
                  onAcknowledge={acknowledge}
                  onViewAll={demo ? undefined : () => navigate(`/location/${locationId}/alarms`)}
                  readOnly={demo}
                />
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default LocationStatusView;
