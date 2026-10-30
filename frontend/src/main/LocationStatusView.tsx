import { useCallback, useMemo, useState } from 'react';
import { Spinner } from 'react-bootstrap';
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
import ThresholdTrendChart, {
  type ThresholdTrendSeries,
} from '../components/device/ThresholdTrendChart';
import PanelCard from '../components/ui/kit/PanelCard';
import KpiStrip from '../components/ui/kit/KpiStrip';
import SegmentedControl from '../components/ui/kit/SegmentedControl';
import PillSelect from '../components/ui/kit/PillSelect';
import type { LocationDetail } from './locationTypes';
import {
  getProjectTypeLabel,
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
  TIME_RANGE_DAYS,
  timeRangeLabelKey,
  type TimeRange,
} from './timeRanges';
import {
  alarmSpansOf,
  highestOf,
  historySpecFor,
  measurePointMeters,
  severityColor,
  toggledSet,
  worstSeverityOf,
  zeitreiheSeriesOf,
  type VerdachtsstelleCluster,
} from './locationStatusData';
import { useAlarmClusters } from './useAlarmClusters';
import { useLocationHistory } from './useLocationHistory';
import { useMeasurementRangeState } from './useMeasurementRange';
import { isDemoUser } from './demo';

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

const formatSpanTime = (ms: number) =>
  new Date(ms).toLocaleString(undefined, {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

const Loading = () => {
  const { t } = useTranslation();
  return (
    <div className="d-flex justify-content-center py-5 text-muted">
      <Spinner animation="border" className="me-2" /> {t('ui_loading')}
    </div>
  );
};

/** Name, project and address of the location, and "request measurement". */
const LocationStatusHeader = ({
  location,
  locationId,
  canRequestMeasurement,
}: {
  location: LocationDetail | null;
  locationId: number;
  canRequestMeasurement: boolean;
}) => {
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const { t } = useTranslation();
  const [requesting, setRequesting] = useState(false);

  const requestMeasurement = () => {
    setRequesting(true);
    void axiosConfig.perform_post(
      auth,
      `/v1/location/${locationId}/request-measurement/`,
      {},
      (response) => {
        showSuccessBar(
          enqueueSnackbar,
          t('status_request_measurement_sent', {
            count: response?.data?.requested_devices ?? 0,
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

  const projectLine = [
    location?.project_id != null ? `#${location.project_id}` : null,
    getProjectTypeLabel(t, location?.project_type),
  ]
    .filter(Boolean)
    .join(' · ');
  const addressLine = [
    location?.address,
    [location?.plz, location?.city].filter(Boolean).join(' '),
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 14,
        flexWrap: 'wrap',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontSize: 28,
            fontWeight: 600,
            color: 'var(--progeo-blue)',
          }}
        >
          {location?.name || '–'}
        </div>
        <div style={{ fontSize: 12.5, color: '#8B8383', marginTop: 2 }}>
          {projectLine}
        </div>
        {addressLine && (
          <div style={{ fontSize: 12.5, color: '#8B8383', marginTop: 1 }}>
            {addressLine}
          </div>
        )}
      </div>
      {canRequestMeasurement && (
        <button
          type="button"
          onClick={requestMeasurement}
          disabled={requesting}
          style={{
            height: 38,
            padding: '0 18px',
            border: 'none',
            borderRadius: 10,
            background: 'var(--progeo-orange)',
            color: '#fff',
            fontFamily: 'inherit',
            fontSize: 13,
            fontWeight: 500,
            cursor: requesting ? 'default' : 'pointer',
            boxShadow: '0 4px 14px rgba(235, 99, 59, .28)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flexShrink: 0,
          }}
        >
          {requesting && <Spinner size="sm" animation="border" />}
          {t('status_request_measurement')}
        </button>
      )}
    </div>
  );
};

/** Object status, open Verdachtsstellen, highest reading and whether the
 * installation reports. */
const StatusKpis = ({
  clusters,
  threshold,
  online,
}: {
  clusters: VerdachtsstelleCluster[];
  threshold: number | null;
  online: boolean;
}) => {
  const { t } = useTranslation();
  const openClusters = clusters.filter((cluster) => cluster.state !== 'geloest');
  const worstSeverity = worstSeverityOf(openClusters);
  const highestReading = highestOf(clusters.map((cluster) => cluster.max_value));

  return (
    <KpiStrip
      tiles={[
        {
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
          label: t('status_kpi_verdachtsstellen'),
          value: String(openClusters.length),
          unit: t('status_kpi_active_unit'),
        },
        {
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
          label: t('status_kpi_anlage'),
          value: online
            ? t('status_kpi_anlage_online')
            : t('status_kpi_anlage_offline'),
          valueColor: online ? '#3F7A1C' : '#8B8383',
        },
      ]}
    />
  );
};

// Zeitreihe ("Letzte 24 h" ... "Letzte 3 Jahre", see timeRanges.ts): the
// measured value of every sensor over the range, cut out of the loaded
// history like the heatmap's frames. Sensors with a Verdachtsstelle are
// highlighted, the others drawn as muted lines.
const ZeitreihePanel = ({
  loading,
  series,
}: {
  loading: boolean;
  series: ThresholdTrendSeries[];
}) => {
  const { t } = useTranslation();
  const [hiddenSeries, setHiddenSeries] = useState<Set<string>>(new Set());

  return (
    <PanelCard title={t('status_zeitreihe_title')}>
      {loading ? (
        <Loading />
      ) : (
        <ThresholdTrendChart
          series={series}
          hiddenSeries={hiddenSeries}
          onToggleSeries={(id) => setHiddenSeries((prev) => toggledSet(prev, id))}
          emptyLabel={t('status_zeitreihe_empty')}
          meanOfLabel={(count) => t('status_zeitreihe_mean_of', { count })}
          thresholdLabel={t('status_zeitreihe_threshold_legend')}
          mutedLabel={(count) => t('status_zeitreihe_other_sensors', { count })}
        />
      )}
    </PanelCard>
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
  const authUser = auth?.user as { is_staff?: boolean; is_superuser?: boolean } | null;
  const isStaff = !demo && Boolean(authUser?.is_staff || authUser?.is_superuser);

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
    () => availableTimeRanges(measurementRange),
    [measurementRange],
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

  const zeitreiheSeries = useMemo(
    () =>
      zeitreiheSeriesOf(
        zeitreihe,
        clusters,
        sensorLabel,
        (sensorId) => measurePointOf(sensorId)?.threshold ?? thresholdValue,
      ),
    [clusters, measurePointOf, sensorLabel, thresholdValue, zeitreihe],
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <LocationStatusHeader
        location={location}
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
                online={(history?.timestamps?.length ?? 0) > 0}
              />
            )
          )}

          <div
            style={{
              display: 'flex',
              gap: 12,
              flexWrap: 'wrap',
              padding: '2px 2px 0',
            }}
          >
            <SegmentedControl
              options={[
                { value: 'roof', label: t('status_view_roof') },
                { value: 'zeitreihe', label: t('status_view_zeitreihe') },
              ]}
              value={statusView}
              onChange={(value) => setStatusView(value as 'roof' | 'zeitreihe')}
            />
            <SegmentedControl
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
              <ZeitreihePanel loading={historyLoading} series={zeitreiheSeries} />
              {isStaff && (
                <LocationBatteryVoltagePanel
                  locationId={locationId}
                  days={rangeDays}
                  demo={demo}
                />
              )}
            </>
          ) : (
            <div
              style={{
                display: 'flex',
                gap: 14,
                alignItems: 'flex-start',
                flexWrap: 'wrap',
              }}
            >
              <div style={{ flex: '1 1 560px', minWidth: 0 }}>
                <LocationPlanPanel
                  heatmap={heatmap}
                  visualization={planVisualization(location?.project_type)}
                  withSensorTable={showsSensorTable(location?.project_type)}
                  threshold={thresholdValue}
                  denied={historyDenied}
                  alarmSpans={alarmSpans}
                />
              </div>
              <div style={{ flex: '1 1 380px', minWidth: 0 }}>
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
