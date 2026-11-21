import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Form, Spinner } from 'react-bootstrap';
import { PencilSquare, Trash } from 'react-bootstrap-icons';
import { useSnackbar } from 'notistack';
import { useSearchParams } from 'react-router';
import { planFromParams } from './planParam';
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
import {
  isLorawanProject,
  planVisualization,
  showsSensorTable,
} from './projectType';
import LocationClimatePanels from './LocationClimatePanels';
import LocationBatteryVoltagePanel from './LocationBatteryVoltagePanel';
import LocationPlanPanel from './LocationPlanPanel';
import VerdachtsstellenPanel from './VerdachtsstellenPanel';
import {
  availableTimeRanges,
  effectiveTimeRange,
  isTimeRange,
  LATEST_RANGE,
  type StatusRange,
  TIME_RANGE_DAYS,
  timeRangeCandidates,
  timeRangeLabelKey,
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
  sensorNameOf,
  severityColor,
  worstSeverityOf,
  type VerdachtsstelleCluster,
} from './locationStatusData';
import { zeitreiheSensorsOf } from './zeitreiheSensors';
import ZeitreihePanel from './ZeitreihePanel';
import { useAlarmClusters } from './useAlarmClusters';
import ComputedSuspicionPanel, {
  SuspicionModeSwitch,
} from './ComputedSuspicionPanel';
import {
  effectiveSuspicionMode,
  suspicionMarkersOf,
  type SuspicionMode,
} from './computedSuspicion';
import { useComputedSuspicion } from './useComputedSuspicion';
import { useLocationHistory } from './useLocationHistory';
import { useMeasurementRangeState } from './useMeasurementRange';
import {
  type LiveMeasurements,
  useLocationLiveRevision,
} from './useLocationLiveRevision';
import { isDemoUser } from './demo';
import { formatDate, formatRelativeTime } from './dateFormat';
import { useAccess } from './access';
import { parseStatusAt, rangeContaining } from './statusAt';
import {
  clearStatusView,
  parseStatusView,
  rangeReaches,
  statusViewKey,
  updateStatusView,
} from './statusViewState';
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
    <div
      className="d-flex justify-content-center py-5 text-muted"
      data-testid="status-loading"
    >
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
  canEditInDjango,
  canDeleteInDjango,
}: {
  locationId: number;
  canRequestMeasurement: boolean;
  canEditInDjango: boolean;
  canDeleteInDjango: boolean;
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
        const list = (
          (response?.data?.devices ?? []) as RequestableDevice[]
        ).filter(
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
  if (
    (!canRequestMeasurement || devices.length === 0) &&
    !canEditInDjango &&
    !canDeleteInDjango
  ) {
    return null;
  }

  return (
    <div className="status-header" data-testid="status-header">
      {(canEditInDjango || canDeleteInDjango) && (
        <div className="status-admin-actions">
          {canEditInDjango && (
            <Button
              as="a"
              size="sm"
              variant="outline-primary"
              href={`/aadmin/progeo/progeolocation/${locationId}/change/`}
              data-testid="status-django-edit"
            >
              <PencilSquare className="me-1" />
              {t('status_edit_location_django')}
            </Button>
          )}
          {canDeleteInDjango && (
            <Button
              as="a"
              size="sm"
              variant="outline-danger"
              href={`/aadmin/progeo/progeolocation/${locationId}/delete/`}
              data-testid="status-django-delete"
            >
              <Trash className="me-1" />
              {t('status_delete_location_django')}
            </Button>
          )}
        </div>
      )}
      {canRequestMeasurement && devices.length > 0 && (
        <div className="status-request" data-testid="status-request">
          {devices.length > 1 && (
            <Form.Select
              data-testid="status-request-device"
              aria-label={t('status_request_measurement_device')}
              title={t('status_request_measurement_device')}
              value={selectedDeviceId ?? ''}
              onChange={(event) =>
                setSelectedDeviceId(Number(event.target.value))
              }
              disabled={requesting}
              className="status-request-device"
            >
              {devices.map((device) => (
                <option key={device.id} value={device.id}>
                  {device.label ||
                    device.display_name ||
                    device.chip_id ||
                    `#${device.id}`}
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
  openSuspicions,
  threshold,
  anlage,
  now,
}: {
  clusters: VerdachtsstelleCluster[];
  /** The open Verdachtsstellen as the panel shows them (the computed
   * points); null: one per sensor. */
  openSuspicions: number | null;
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
  const upcoming =
    anlage.state === 'online' ? nextMeasurementOf(anlage.next, tileNow) : null;
  const anlageNote = [
    anlage.last != null
      ? t('status_kpi_anlage_last', {
          time: formatRelativeTime(anlage.last, tileNow),
        })
      : t('status_kpi_anlage_last_unknown'),
    upcoming &&
      (upcoming.overdue
        ? t('status_kpi_anlage_next_overdue', {
            time: formatMinutes(upcoming.minutes),
          })
        : t('status_kpi_anlage_next', {
            time: formatMinutes(upcoming.minutes),
          })),
  ]
    .filter(Boolean)
    .join(' · ');
  const openClusters = clusters.filter(
    (cluster) => cluster.state !== 'geloest',
  );
  const worstSeverity = worstSeverityOf(openClusters);
  const openCount = openSuspicions ?? openClusters.length;
  const highestReading = highestOf(
    clusters.map((cluster) => cluster.max_value),
  );

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
          note: openCount
            ? t('status_kpi_note_open', { count: openCount })
            : t('status_kpi_note_none'),
          valueColor: severityColor(worstSeverity),
        },
        {
          testId: 'status-kpi-verdachtsstellen',
          label: t('status_kpi_verdachtsstellen'),
          value: String(openCount),
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
            anlage.state === 'online'
              ? '#3F7A1C'
              : anlage.state === 'offline'
                ? '#C44D26'
                : '#8B8383',
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
  const { t } = useTranslation();
  const { hasPermission, isStaffOrSuperuser } = useAccess();
  // The demo user sees the regular portal, but no actions with real side
  // effects (a measurement request reaches the devices).
  const readOnlyDemo = demo || isDemoUser(auth.user);
  // Battery charts are device maintenance - staff (and superusers) only.
  const isStaff = !demo && isStaffOrSuperuser;
  const canEditInDjango =
    !readOnlyDemo &&
    isStaffOrSuperuser &&
    hasPermission('module_locations_django_edit');
  const canDeleteInDjango =
    !readOnlyDemo &&
    isStaffOrSuperuser &&
    hasPermission('module_locations_django_delete');

  const [statusView, setStatusView] = useState<'roof' | 'zeitreihe'>('roof');
  // The range of both views - the plan's frames and the Zeitreihe; or
  // "Letzte Messung" (LATEST_RANGE): the newest 10 measurements.
  const [selectedRange, setSelectedRange] = useState<StatusRange>('7d');
  // Step of the plan's frames, picked in its dropdown; null: the range's default.
  const [pickedStep, setPickedStep] = useState<number | null>(null);
  // "Now" until the data arrives (the parent remounts per location).
  const [openedAt] = useState(() => Date.now());
  // The sensor picked on the plan - the Zeitreihe's first entry.
  const [selectedSensor, setSelectedSensor] = useState<number | null>(null);
  // Staff: the plan's heat as another value per sensor (WP, EP, WP + EP) -
  // its own history, only for the heatmap; the Zeitreihe, the KPIs and the
  // sensor table keep |WP - EP| (the alarm value).
  const [heatProfile, setHeatProfile] = useState<HeatProfile>('diff');
  // The sensor hovered in a Verdachtsstelle's sensor list - pointed out on the plan.
  const [hoveredSensor, setHoveredSensor] = useState<number | null>(null);
  // A moment asked for on the page (a Verdachtsstelle's first detection):
  // the plan's slider goes there - `revision` also when it is asked twice.
  const [jump, setJump] = useState<{ at: number; revision: number } | null>(
    null,
  );

  // The settings of the URL, applied when the page opens and whenever they
  // change: an escalation's quick link (view, range, step, sensor, sensors,
  // profile - statusViewState.ts) and ?at=<ISO-8601> (e.g. an event of the
  // notification history): the plan at that moment - a range that contains
  // it, its frame shown first.
  const [searchParams] = useSearchParams();
  const requested = useMemo(
    () => parseStatusView(searchParams),
    [searchParams],
  );
  const requestedKey = statusViewKey(requested);
  const atParam = searchParams.get('at');
  const focusAt = useMemo(() => parseStatusAt(atParam), [atParam]);
  const [applied, setApplied] = useState<{
    at: number | null;
    key: string;
  } | null>(null);
  if (
    applied === null ||
    applied.at !== focusAt ||
    applied.key !== requestedKey
  ) {
    setApplied({ at: focusAt, key: requestedKey });
    // A new ?at= wins over a moment asked for on the page.
    setJump(null);
    if (requested.view) {
      setStatusView(requested.view);
    }
    if (requested.sensor != null) {
      setSelectedSensor(requested.sensor);
    }
    if (requested.profile && isStaff) {
      setHeatProfile(requested.profile);
    }
    let focusRange = requested.range ?? null;
    let focusStep = requested.step ?? null;
    // The requested range must still reach back to the moment - else the
    // shortest that does (its default step).
    if (
      focusAt != null &&
      !(focusRange && rangeReaches(focusRange, focusAt, openedAt))
    ) {
      focusRange = rangeContaining(
        focusAt,
        openedAt,
        timeRangeCandidates({ long: true, staff: isStaff }),
      );
      focusStep = null;
      if (!requested.view) {
        setStatusView('roof');
      }
    }
    if (focusRange) {
      setSelectedRange(focusRange);
      setPickedStep(focusStep);
    }
  }

  // LoRaWAN objects have no samples (no heatmap, no Verdachtsstellen) - they
  // show humidity/temperature charts instead, see LocationClimatePanels.
  const isLorawan = isLorawanProject(location?.project_type);

  // New data while the page is open (every controller sample, and whatever
  // came while the socket was down): the range, the history, the
  // Verdachtsstellen and the KPIs reload quietly, the picked view, range
  // and sensor stay - a toast tells new measurements.
  const { enqueueSnackbar } = useSnackbar();
  const onLiveMeasurements = useCallback(
    ({ count, alarm }: LiveMeasurements) =>
      enqueueSnackbar(
        count === null
          ? // Found by the background check: how many is unknown.
            t('status_live_measurement_new')
          : t(
              alarm
                ? 'status_live_measurement_alarm'
                : 'status_live_measurement',
              { count },
            ),
        { variant: alarm ? 'warning' : 'info' },
      ),
    [enqueueSnackbar, t],
  );
  const liveRevision = useLocationLiveRevision(
    locationId,
    !demo && !isLorawan,
    onLiveMeasurements,
  );

  // The history to load, and the long Zeitreihe ranges once the data
  // reaches that far back (LoRaWAN: LocationClimatePanels does its own).
  const {
    range: measurementRange,
    failed: measurementRangeFailed,
    // The history follows once the range of the new data is there (its
    // window ends at the newest measurement).
    revision: rangeRevision,
  } = useMeasurementRangeState(locationId, demo, !isLorawan, liveRevision);
  const rangeOptions = useMemo(
    () =>
      availableTimeRanges(
        measurementRange,
        timeRangeCandidates({ long: true, staff: isStaff }),
      ),
    [isStaff, measurementRange],
  );
  const isLatest = selectedRange === LATEST_RANGE;
  const range: StatusRange = isLatest
    ? LATEST_RANGE
    : effectiveTimeRange(selectedRange, rangeOptions);
  // The days of what goes with a period (computed suspicion points, battery
  // chart): the latest measurement goes with the last 24 h.
  const rangeDays = isTimeRange(range)
    ? TIME_RANGE_DAYS[range]
    : TIME_RANGE_DAYS['24h'];

  // What the page shows - an escalation created now keeps it (statusViewState.ts).
  useEffect(() => {
    updateStatusView(locationId, {
      view: statusView,
      range,
      step: pickedStep ?? undefined,
      sensor: selectedSensor ?? undefined,
      profile: heatProfile === 'diff' ? undefined : heatProfile,
    });
  }, [locationId, statusView, range, pickedStep, selectedSensor, heatProfile]);
  useEffect(() => () => clearStatusView(locationId), [locationId]);
  const onFrameTimeChange = useCallback(
    (ms: number | null) =>
      updateStatusView(locationId, {
        at: ms != null ? new Date(ms).toISOString() : undefined,
      }),
    [locationId],
  );
  const onZeitreiheShown = useCallback(
    (ids: string[]) =>
      updateStatusView(locationId, { sensors: ids.length ? ids : undefined }),
    [locationId],
  );

  const historySpec = useMemo(
    () =>
      isLorawan
        ? null
        : historySpecFor(measurementRange, measurementRangeFailed, openedAt),
    [isLorawan, measurementRange, measurementRangeFailed, openedAt],
  );
  // The whole history is only loaded for a period - "Letzte Messung" needs
  // ten small frames (?latest=1) and reloads just those on new data.
  const periodSpec = isLatest ? null : historySpec;
  const {
    history,
    loadedAt: historyLoadedAt,
    loading: historyLoading,
    denied: historyDenied,
  } = useLocationHistory(locationId, demo, periodSpec, 'diff', rangeRevision);
  const profileHistory = useLocationHistory(
    locationId,
    demo,
    heatProfile === 'diff' ? null : periodSpec,
    heatProfile,
    rangeRevision,
  );
  const latestSpec = isLatest && !isLorawan ? 'latest' : null;
  const latest = useLocationHistory(
    locationId,
    demo,
    latestSpec,
    'diff',
    liveRevision,
  );
  const latestProfile = useLocationHistory(
    locationId,
    demo,
    heatProfile === 'diff' ? null : latestSpec,
    heatProfile,
    liveRevision,
  );
  const shownLoading = isLatest ? latest.loading : historyLoading;
  const shownDenied = isLatest ? latest.denied : historyDenied;
  const {
    clusters,
    loading: clustersLoading,
    denied: clustersDenied,
    loadedAt: clustersLoadedAt,
    acknowledging,
    acknowledge,
  } = useAlarmClusters(locationId, demo, !isLorawan, liveRevision);
  // Computed suspicion points of the range instead of one Verdachtsstelle
  // per sensor (every product) - staff can switch (computedSuspicion.ts).
  const [pickedSuspicionMode, setSuspicionMode] =
    useState<SuspicionMode>('computed');
  const suspicionMode = effectiveSuspicionMode(isStaff, pickedSuspicionMode);
  const computed = useComputedSuspicion(
    locationId,
    rangeDays,
    demo,
    // LoRaWAN climate objects have no Verdachtsstellen.
    suspicionMode === 'computed' && !isLorawan,
    liveRevision,
  );
  const suspicionMarkers = useMemo(
    () =>
      suspicionMode === 'computed'
        ? suspicionMarkersOf(computed.points)
        : undefined,
    [suspicionMode, computed.points],
  );

  // The step of the loaded history: the plan's steps must be multiples.
  const baseStep = history?.step ?? historySpec?.step ?? null;
  const stepOptions = useMemo(
    () => stepsForRange(rangeDays, baseStep),
    [rangeDays, baseStep],
  );
  const heatmapStep =
    pickedStep != null &&
    stepOptions.some((step) => step.seconds === pickedStep)
      ? pickedStep
      : defaultStepForRange(rangeDays, baseStep);

  // The range (the last N days up to when the history arrived), for the
  // plan's frames and the Zeitreihe - cut out of the history, no request.
  const now = (isLatest ? latest.loadedAt : historyLoadedAt) ?? openedAt;
  const heatmap = useMemo(
    () =>
      isLatest
        ? latest.history
        : framesOf(history, {
            from: now - rangeDays * DAY_MS,
            to: now,
            step: heatmapStep,
          }),
    [isLatest, latest.history, history, now, rangeDays, heatmapStep],
  );
  // While the picked profile loads, the heat keeps |WP - EP|.
  const profileSource = isLatest ? latestProfile : profileHistory;
  const profileHistoryShown =
    heatProfile !== 'diff' && profileSource.history
      ? profileSource.history
      : null;
  const profileHeatmap = useMemo(
    () =>
      profileHistoryShown && !isLatest
        ? framesOf(profileHistoryShown, {
            from: now - rangeDays * DAY_MS,
            to: now,
            step: heatmapStep,
          })
        : profileHistoryShown,
    [isLatest, profileHistoryShown, now, rangeDays, heatmapStep],
  );
  // "Letzte Messung": its ten frames - the same the plan and its table show.
  const zeitreihe = useMemo(
    () =>
      isLatest
        ? latest.history
        : seriesOf(
            history,
            now - rangeDays * DAY_MS,
            now,
            ZEITREIHE_LIMIT,
            baseStep ?? 30 * 60,
          ),
    [isLatest, latest.history, baseStep, history, now, rangeDays],
  );

  const thresholdValue = location?.alarm_threshold ?? null;
  const shownHistory = isLatest ? latest.history : history;
  const sensorPoints = useMemo(
    () => shownHistory?.sensor_points ?? [],
    [shownHistory],
  );
  // The placed ProgeoMeasurePoint of a sensor, if any: its name and own
  // threshold override win over the generic label/object default.
  const measurePointOf = useCallback(
    (sensorId: number) => sensorPoints.find((point) => point.pos === sensorId),
    [sensorPoints],
  );
  // The name the plan gives a sensor (its own, else its dm band / line);
  // "Sensor #7" only without one.
  const visualization = planVisualization(location?.project_type);
  const sensorLabel = useCallback(
    (sensorId: number) =>
      sensorNameOf(
        measurePointOf(sensorId),
        visualization === 'lines'
          ? (row) => t('status_line_label', { line: row + 1 })
          : null,
      ) ?? t('status_sensor_label', { sensor: sensorId }),
    [measurePointOf, t, visualization],
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
        (sensorId) => Boolean(measurePointOf(sensorId)?.disabled),
      ),
    [measurePointOf, sensorLabel, thresholdValue, zeitreihe],
  );

  const alarmSpans = useMemo(
    () =>
      alarmSpansOf(
        clusters,
        clustersLoadedAt ?? openedAt,
        (cluster, from, to) =>
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

  // "Erstes Auftreten anzeigen": the plan's slider to that moment - in a
  // range that reaches back to it (the shortest available, as for ?at=).
  const showMoment = useCallback(
    (iso: string) => {
      const at = Date.parse(iso);
      if (!Number.isFinite(at)) {
        return;
      }
      setJump((prev) => ({ at, revision: (prev?.revision ?? 0) + 1 }));
      if (!rangeReaches(range, at, now)) {
        const reaching = rangeContaining(at, now, rangeOptions);
        if (reaching) {
          setSelectedRange(reaching);
          setPickedStep(null);
        }
      }
    },
    [now, range, rangeOptions],
  );

  // In the panel's header - a row of its own pushed the panel below the plan's top.
  const suspicionSwitch = isStaff ? (
    <SuspicionModeSwitch mode={suspicionMode} onChange={setSuspicionMode} />
  ) : undefined;

  return (
    <div className="status-view" data-testid="page-location-status">
      <LocationStatusHeader
        locationId={locationId}
        canRequestMeasurement={!isLorawan && !readOnlyDemo}
        canEditInDjango={canEditInDjango}
        canDeleteInDjango={canDeleteInDjango}
      />

      {isLorawan ? (
        <LocationClimatePanels
          locationId={locationId}
          demo={demo}
          showBattery={isStaff}
        />
      ) : (
        <>
          {clustersLoading || shownLoading ? (
            <Loading />
          ) : (
            !clustersDenied && (
              <StatusKpis
                clusters={clusters}
                openSuspicions={
                  suspicionMode === 'computed' && !computed.loading
                    ? computed.points.filter(
                        (point) => point.state !== 'geloest',
                      ).length
                    : null
                }
                threshold={thresholdValue}
                anlage={anlageStatusOf(
                  measurementRange,
                  measurementRangeFailed,
                  now,
                )}
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
              options={[LATEST_RANGE, ...rangeOptions].map((value) => ({
                value,
                label: t(timeRangeLabelKey(value)),
              }))}
              value={range}
              onChange={(value) => {
                setSelectedRange(value as StatusRange);
                setPickedStep(null);
              }}
            />
          </div>

          {statusView === 'zeitreihe' ? (
            <>
              <ZeitreihePanel
                loading={shownLoading}
                sensors={zeitreiheSensors}
                selectedSensorId={selectedSensor}
                requestedIds={requested.sensors ?? null}
                onShownChange={onZeitreiheShown}
              />
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
                  preferredPlanId={planFromParams(searchParams)}
                  heatmap={heatmap}
                  visualization={visualization}
                  withSensorTable={showsSensorTable(location?.project_type)}
                  threshold={thresholdValue}
                  denied={shownDenied}
                  alarmSpans={alarmSpans}
                  profileHeatmap={profileHeatmap}
                  profile={heatProfile}
                  onProfileChange={setHeatProfile}
                  profileLoading={
                    heatProfile !== 'diff' && profileSource.loading
                  }
                  focusTime={jump?.at ?? focusAt}
                  focusRevision={jump?.revision ?? 0}
                  // The step only matters for the animation: beside its start.
                  frameToolbar={
                    !isLatest &&
                    stepOptions.length > 1 && (
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
                    )
                  }
                  selectedSensor={selectedSensor}
                  onSensorSelect={(pos) =>
                    setSelectedSensor((current) =>
                      current === pos ? null : pos,
                    )
                  }
                  suspicions={suspicionMarkers}
                  highlightedSensor={hoveredSensor}
                  onFrameTimeChange={onFrameTimeChange}
                />
              </div>
              <div className="status-column-side">
                {suspicionMode === 'computed' ? (
                  <ComputedSuspicionPanel
                    points={computed.points}
                    loading={computed.loading}
                    denied={computed.denied}
                    sensorLabel={sensorLabel}
                    acknowledging={computed.acknowledging}
                    onAcknowledge={computed.acknowledge}
                    readOnly={demo}
                    headerActions={suspicionSwitch}
                    onSensorHover={setHoveredSensor}
                    onShowMoment={showMoment}
                  />
                ) : (
                  <VerdachtsstellenPanel
                    clusters={clusters}
                    denied={clustersDenied}
                    sensorLabel={sensorLabel}
                    metersOf={metersOf}
                    disabledOf={(sensorId) =>
                      Boolean(measurePointOf(sensorId)?.disabled)
                    }
                    acknowledging={acknowledging}
                    onAcknowledge={acknowledge}
                    readOnly={demo}
                    headerActions={suspicionSwitch}
                    onShowMoment={showMoment}
                  />
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default LocationStatusView;
