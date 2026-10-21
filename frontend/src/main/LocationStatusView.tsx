import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Spinner } from 'react-bootstrap';
import { ChevronDown, ChevronRight, CheckLg } from 'react-bootstrap-icons';
import { useSnackbar } from 'notistack';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig';
import {
  errorReason,
  showErrorBar,
  showRequestError,
  showSuccessBar,
} from '../components/ui/Snackbar.jsx';
import SensorHeatmap2D from '../components/device/SensorHeatmap2D';
import FrameSlider, { type AlarmSpan } from '../components/device/FrameSlider';
import { framesOf, seriesOf } from '../components/device/heatmapData';
import {
  defaultStepForRange,
  heatmapQuery,
  type HeatmapWindow,
  historyWindow,
  stepsForRange,
} from '../components/device/heatmapSteps';
import { formatMeters } from '../components/device/planMeters';
import type { SensorHeatmapResponse } from '../components/device/sensorHeatmapTypes';
import LageplanZoneOverlay from '../components/device/LageplanZoneOverlay';
import SensorListTable, {
  type SensorListRow,
} from '../components/device/SensorListTable';
import ThresholdTrendChart, {
  type ThresholdTrendSeries,
} from '../components/device/ThresholdTrendChart';
import PanelCard from '../components/ui/kit/PanelCard';
import KpiStrip from '../components/ui/kit/KpiStrip';
import SegmentedControl from '../components/ui/kit/SegmentedControl';
import PillSelect from '../components/ui/kit/PillSelect';
import StateBadge, { type AlarmState } from '../components/ui/kit/StateBadge';
import SeverityBadge, {
  type Severity,
} from '../components/ui/kit/SeverityBadge';
import type { LocationDetail } from './locationTypes';
import {
  getProjectTypeLabel,
  isLorawanProject,
  planVisualization,
  showsSensorTable,
} from './projectType';
import LocationClimatePanels from './LocationClimatePanels';
import LocationBatteryVoltagePanel from './LocationBatteryVoltagePanel';
import {
  availableTimeRanges,
  effectiveTimeRange,
  TIME_RANGE_DAYS,
  timeRangeLabelKey,
  type TimeRange,
} from './timeRanges';
import { useMeasurementRangeState } from './useMeasurementRange';
import { isDemoUser } from './demo';

type LocationStatusViewProps = {
  location: LocationDetail | null;
  locationId: number;
  /** Public demo view: reads /v1/demo/... and offers no write actions. */
  demo?: boolean;
};

// The backend now owns severity/state/clustering entirely
// (ProgeoAlarm.severity, the auto-GELOEST transition, and
// AlarmViewSet.clusters) - this view just renders what it returns.
// A Verdachtsstelle is one sensor: every sensor_id an alarm reported as
// over-threshold, rolled up across every alarm that flagged it.
type VerdachtsstelleCluster = {
  id: string;
  sensor_id: number;
  device_ids: number[];
  device_label: string | null;
  device_type: string | null;
  alarm_ids: number[];
  /** Current state: "geloest" once no alarm of this sensor is open anymore. */
  state: AlarmState;
  /** Whether an alarm of this sensor is still open (not normalized). */
  active: boolean;
  severity: Severity;
  max_value: number | null;
  /** Start of the sensor's latest alarm episode (re-triggers merged). */
  since: string | null;
  /** When that episode ended; null while still active. */
  resolved_at: string | null;
  ack_by: string | null;
  ack_at: string | null;
  pending_ack_alarm_ids: number[];
  alarms: {
    id: number | string;
    triggered_at: string | null;
    value: number | null;
    state: AlarmState;
  }[];
};

const ALARM_WINDOW_DAYS = 90;
// Points per Zeitreihe range at most (30 days hourly), each the highest
// value of its part of the range.
const ZEITREIHE_LIMIT = 720;
// History loaded without a known measurement range (none, or it failed).
const FALLBACK_HISTORY_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const SEVERITY_ORDER: Record<Severity, number> = {
  beobachten: 0,
  alarm: 1,
  kritisch: 2,
};

// Zeitreihe ("Letzte 24 h" ... "Letzte 3 Jahre", see timeRanges.ts): the
// measured value of every sensor over the range, cut out of the loaded
// history like the heatmap's frames. Sensors with a Verdachtsstelle are
// highlighted, the others drawn as muted lines.

/** A sensor's value in a frame of the heatmap; null without one. */
const frameValue = (heatmap: SensorHeatmapResponse | null, index: number | null, pos: number) => {
  if (!heatmap || index == null) {
    return null;
  }
  const raw = heatmap.data?.[String(pos)]?.[index];
  const value = raw == null ? Number.NaN : Number(raw);
  return Number.isFinite(value) ? value : null;
};

const LocationStatusView = ({
  location,
  locationId,
  demo = false,
}: LocationStatusViewProps) => {
  const auth = useAuth();
  const navigate = useNavigate();
  const { enqueueSnackbar } = useSnackbar();
  // The demo user sees the regular portal, but no actions with real side
  // effects (a measurement request reaches the devices).
  const readOnlyDemo = demo || isDemoUser(auth.user);
  const { t } = useTranslation();

  // The location's whole history in a fine base step (historyWindow),
  // loaded once: every window and step of the plan, and the Zeitreihe, are
  // cut out of it in the browser (heatmapData.ts) - nothing is refetched.
  const [history, setHistory] = useState<SensorHeatmapResponse | null>(null);
  const historyRequested = useRef<string | null>(null);
  // Frame the plan shows (its slider) - the sensor table follows it.
  const [heatmapIndex, setHeatmapIndex] = useState<number | null>(null);
  const [heatmapLoading, setHeatmapLoading] = useState(true);
  const [heatmapDenied, setHeatmapDenied] = useState(false);
  // Step of the plan's frames, picked in its dropdown; null: the range's default.
  const [pickedStep, setPickedStep] = useState<number | null>(null);

  const [clusters, setClusters] = useState<VerdachtsstelleCluster[]>([]);
  const [clustersLoading, setClustersLoading] = useState(true);
  const [clustersDenied, setClustersDenied] = useState(false);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [acknowledging, setAcknowledging] = useState<Set<string>>(new Set());
  const [requestingMeasurement, setRequestingMeasurement] = useState(false);
  const [statusView, setStatusView] = useState<'roof' | 'zeitreihe'>('roof');
  const [hiddenSeries, setHiddenSeries] = useState<Set<string>>(new Set());
  // The range of both views - the plan's frames and the Zeitreihe.
  const [selectedRange, setSelectedRange] =
    useState<TimeRange>('7d');

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
  const range = effectiveTimeRange(
    selectedRange,
    rangeOptions,
  );
  const rangeDays = TIME_RANGE_DAYS[range];

  const requestMeasurement = () => {
    setRequestingMeasurement(true);
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
        setRequestingMeasurement(false);
      },
      (error) => {
        const reason = errorReason(error);
        showErrorBar(
          enqueueSnackbar,
          t('status_request_measurement_error', { reason }),
        );
        setRequestingMeasurement(false);
      },
    );
  };

  // Every measurement of the location in its base step; without a range
  // (no measurements yet, or it failed) the last FALLBACK_HISTORY_DAYS - the
  // response still brings the plans and measure points.
  const historySpec = useMemo(() => {
    if (isLorawan) {
      return null;
    }
    const first = measurementRange?.first ? Date.parse(measurementRange.first) : Number.NaN;
    const last = measurementRange?.last ? Date.parse(measurementRange.last) : Number.NaN;
    if (Number.isFinite(first) && Number.isFinite(last)) {
      return historyWindow(first, last);
    }
    if (measurementRange || measurementRangeFailed) {
      const now = Date.now();
      return historyWindow(now - FALLBACK_HISTORY_DAYS * DAY_MS, now);
    }
    return null; // the range is still loading
  }, [isLorawan, measurementRange, measurementRangeFailed]);

  useEffect(() => {
    setHistory(null);
    setHeatmapLoading(true);
    setHeatmapIndex(null);
  }, [locationId]);

  useEffect(() => {
    if (!historySpec) {
      return;
    }
    const url = `${demo ? '/v1/demo' : '/v1/location'}/${locationId}/heatmap/?${heatmapQuery(historySpec)}`;
    if (historyRequested.current === url) {
      return;
    }
    historyRequested.current = url;
    setHeatmapDenied(false);
    void axiosConfig.perform_get(
      auth,
      url,
      (response) => {
        if (historyRequested.current !== url) {
          return;
        }
        setHistory((response?.data || null) as SensorHeatmapResponse | null);
        setHeatmapLoading(false);
      },
      (error) => {
        if (historyRequested.current !== url) {
          return;
        }
        if (error?.response?.status === 403) {
          setHeatmapDenied(true);
        } else {
          showRequestError(enqueueSnackbar, 'Could not load heatmap', error);
        }
        setHeatmapLoading(false);
      },
    );
  }, [auth, demo, enqueueSnackbar, historySpec, locationId]);

  // The step of the loaded history: the plan's steps must be multiples.
  const baseStep = history?.step ?? historySpec?.step ?? null;
  const stepOptions = useMemo(() => stepsForRange(rangeDays, baseStep), [rangeDays, baseStep]);
  const heatmapStep =
    pickedStep != null && stepOptions.some((step) => step.seconds === pickedStep)
      ? pickedStep
      : defaultStepForRange(rangeDays, baseStep);

  // The range's frames (the last N days) - cut out of the history, no request.
  const heatmapWindow = useMemo<HeatmapWindow>(() => {
    const now = Date.now();
    return { from: now - rangeDays * DAY_MS, to: now, step: heatmapStep };
    // `history` too: a reload of the page's data moves "now" along.
  }, [history, rangeDays, heatmapStep]);
  const heatmap = useMemo(() => framesOf(history, heatmapWindow), [history, heatmapWindow]);

  // Once per location (`auth` changes with the path, no reason to ask again).
  const authRef = useRef(auth);
  authRef.current = auth;
  const loadClusters = useCallback(() => {
    setClustersLoading(true);
    setClustersDenied(false);
    void axiosConfig.perform_get(
      authRef.current,
      demo
        ? `/v1/demo/alarm-clusters/?location=${locationId}&days=${ALARM_WINDOW_DAYS}`
        : `/v1/alarm/clusters/?location=${locationId}&days=${ALARM_WINDOW_DAYS}`,
      (response) => {
        setClusters(
          (response?.data?.clusters || []) as VerdachtsstelleCluster[],
        );
        setClustersLoading(false);
      },
      (error) => {
        if (error?.response?.status === 403) {
          setClustersDenied(true);
        } else {
          showRequestError(
            enqueueSnackbar,
            'Could not load suspected leaks',
            error,
          );
        }
        setClustersLoading(false);
      },
    );
  }, [demo, enqueueSnackbar, locationId]);

  useEffect(() => {
    if (isLorawan) {
      return;
    }
    loadClusters();
  }, [isLorawan, loadClusters]);

  // The Zeitreihe range (the last N days), from the history as well.
  const zeitreihe = useMemo(() => {
    if (!history) {
      return null;
    }
    const now = Date.now();
    return seriesOf(history, now - rangeDays * DAY_MS, now, ZEITREIHE_LIMIT, baseStep ?? 30 * 60);
  }, [baseStep, history, rangeDays]);

  const zeitreiheLoading = heatmapLoading;

  const openClusters = useMemo(
    () => clusters.filter((cluster) => cluster.state !== 'geloest'),
    [clusters],
  );

  const worstSeverity = useMemo(() => {
    return openClusters.reduce<Severity | null>((worst, cluster) => {
      if (!worst || SEVERITY_ORDER[cluster.severity] > SEVERITY_ORDER[worst]) {
        return cluster.severity;
      }
      return worst;
    }, null);
  }, [openClusters]);

  const highestReading = useMemo(() => {
    return clusters.reduce<number | null>((best, cluster) => {
      if (cluster.max_value == null) {
        return best;
      }
      return best == null || cluster.max_value > best
        ? cluster.max_value
        : best;
    }, null);
  }, [clusters]);

  const isOnline = (history?.timestamps?.length ?? 0) > 0;
  const thresholdValue = location?.alarm_threshold ?? null;

  // Per product (ProgeoLocation.project_type, see projectType.ts): heatmap,
  // lines, segments or points on the plan, and whether the sensor table
  // with the sensors' names goes below it.
  const visualization = planVisualization(location?.project_type);
  const withSensorTable = showsSensorTable(location?.project_type);

  // The views of the location (floors, buildings, ...): its active
  // Lageplans - inactive ones are older versions. Without an active one, the
  // newest.
  const planViews = useMemo(() => {
    const plans = history?.location?.lageplans;
    if (!Array.isArray(plans) || plans.length === 0) {
      return [];
    }
    const active = plans.filter((plan) => plan.is_active);
    return active.length > 0 ? active : [plans[0]];
  }, [history]);
  const [selectedPlanId, setSelectedPlanId] = useState<number | null>(null);
  const activeLageplan =
    planViews.find((plan) => plan.id === selectedPlanId) ?? planViews[0] ?? null;
  const hasLageplan = Boolean(activeLageplan);

  const sensorPoints = useMemo(() => history?.sensor_points ?? [], [history]);
  const hasMeasurePoints = sensorPoints.length > 0;

  // The sensors of the shown view; points without a Lageplan of the views
  // (none set, or an old version) stay on the first view.
  const viewPoints = useMemo(() => {
    if (planViews.length < 2 || !activeLageplan) {
      return sensorPoints;
    }
    const viewIds = new Set(planViews.map((plan) => plan.id));
    const onFirstView = activeLageplan.id === planViews[0].id;
    return sensorPoints.filter((point) =>
      point.lageplan != null && viewIds.has(point.lageplan)
        ? point.lageplan === activeLageplan.id
        : onFirstView,
    );
  }, [activeLageplan, planViews, sensorPoints]);

  // The heatmap of the shown view only: its plan and its sensors.
  const viewHeatmap = useMemo(() => {
    if (!heatmap || planViews.length < 2 || !activeLageplan) {
      return heatmap;
    }
    return {
      ...heatmap,
      location: { ...heatmap.location, lageplans: [activeLageplan] },
      sensor_points: viewPoints,
    };
  }, [activeLageplan, heatmap, planViews.length, viewPoints]);

  // The plan overlays show the frame of their slider - the newest one
  // whenever the window changes (the heatmap's own slider starts oldest).
  const frameTotal = heatmap?.timestamps.length ?? 0;
  useEffect(() => {
    if (visualization !== 'heatmap') {
      setHeatmapIndex(frameTotal > 0 ? frameTotal - 1 : null);
    }
  }, [visualization, heatmap, frameTotal]);

  // smartex® dm: the sensors of one grid row are one line (a sensor run) -
  // drawn joined, listed as one table row and judged by their strongest
  // reading. Named after their common measure point name, else numbered.
  const sensorLines = useMemo(() => {
    if (visualization !== 'lines') {
      return [];
    }
    const rows = new Map<number, typeof viewPoints>();
    const singles: typeof viewPoints = [];
    viewPoints.forEach((point) => {
      if (point.grid_y == null) {
        singles.push(point);
      } else {
        rows.set(point.grid_y, [...(rows.get(point.grid_y) ?? []), point]);
      }
    });
    const named = (points: typeof viewPoints) => {
      const names = new Set(points.map((point) => point.name || ''));
      return names.size === 1 ? [...names][0] || null : null;
    };
    return [
      ...[...rows.entries()]
        .sort(([a], [b]) => a - b)
        .map(([row, points]) => ({
          key: `row-${row}`,
          label: named(points) ?? t('status_line_label', { line: row + 1 }),
          points: [...points].sort((a, b) => a.pos - b.pos),
        })),
      ...singles.map((point) => ({
        key: `single-${point.pos}`,
        label: point.name || `#${point.pos}`,
        points: [point],
      })),
    ];
  }, [t, viewPoints, visualization]);

  // LageplanZoneOverlay (every product but the heatmap ones) - sensor_points
  // already carry the same normalized x/y the heatmap markers use. Lines
  // join the sensors of one grid row; segments group by the zone name.
  const zonePoints = useMemo(() => {
    const lineOf = new Map(
      sensorLines.flatMap((line) => line.points.map((point) => [point.pos, line] as const)),
    );
    return viewPoints.map((point) => ({
        pos: point.pos,
        x: point.x,
        y: point.y,
        name: point.name ?? null,
        ...(visualization === 'lines'
          ? {
              group: point.grid_y != null ? `row-${point.grid_y}` : null,
              groupLabel: lineOf.get(point.pos)?.label ?? null,
            }
          : {}),
        value: frameValue(heatmap, heatmapIndex, point.pos) ?? point.last_value ?? null,
        threshold: point.threshold ?? thresholdValue,
        meters:
          point.x_m != null && point.y_m != null
            ? ([point.x_m, point.y_m] as [number, number])
            : null,
      }));
  }, [viewPoints, sensorLines, thresholdValue, visualization, heatmap, heatmapIndex]);

  // The placed ProgeoMeasurePoint of a sensor, if any: its name and own
  // threshold override win over the generic label/object default.
  const measurePointOf = useCallback(
    (sensorId: number) => sensorPoints.find((point) => point.pos === sensorId),
    [sensorPoints],
  );
  // Position in meters of a sensor's measure point, from the heatmap data
  // (null while the active Lageplan isn't calibrated).
  const metersOf = useCallback(
    (sensorId: number): [number, number] | null => {
      const point = measurePointOf(sensorId);
      return point?.x_m != null && point.y_m != null
        ? [point.x_m, point.y_m]
        : null;
    },
    [measurePointOf],
  );
  const sensorLabel = useCallback(
    (sensorId: number) =>
      measurePointOf(sensorId)?.name ||
      t('status_sensor_label', { sensor: sensorId }),
    [measurePointOf, t],
  );

  // Every sensor's measured values in the range; the sensors with a
  // Verdachtsstelle (resolved ones too) first and in colour, the others
  // muted - unless there is none, then all of them in colour.
  const zeitreiheSeries = useMemo((): ThresholdTrendSeries[] => {
    const loaded = zeitreihe;
    if (!loaded) {
      return [];
    }
    const suspected = new Set(clusters.map((cluster) => cluster.sensor_id));
    const series = Object.keys(loaded.data)
      .map(Number)
      .sort((a, b) => a - b)
      .map((sensorId) => ({
        id: `sensor-${sensorId}`,
        label: sensorLabel(sensorId),
        threshold: measurePointOf(sensorId)?.threshold ?? thresholdValue,
        muted: suspected.size > 0 && !suspected.has(sensorId),
        points: (loaded.data[sensorId] || []).map((value, index) => {
          const timestamp = loaded.timestamps[index];
          return {
            id: `${sensorId}:${index}`,
            triggered_at:
              timestamp != null ? new Date(timestamp * 1000).toISOString() : null,
            value,
          };
        }),
      }));
    return [
      ...series.filter((entry) => !entry.muted),
      ...series.filter((entry) => entry.muted),
    ];
  }, [
    clusters,
    measurePointOf,
    sensorLabel,
    thresholdValue,
    zeitreihe,
  ]);

  // Plain sensor table: built from ProgeoMeasurePoint when placed (name +
  // its own threshold override), otherwise straight from the heatmap's raw
  // per-index series (a Lageplan with no measure points yet still has
  // devices reporting - #index is the best label available).
  // Per sensor once per loaded heatmap: the newest and the highest value -
  // moving the slider then only looks values up, nothing is fetched again.
  const sensorStats = useMemo(() => {
    const stats = new Map<string, { latest: number | null; max: number | null }>();
    Object.entries(heatmap?.data ?? {}).forEach(([key, series]) => {
      let latest: number | null = null;
      let max: number | null = null;
      (Array.isArray(series) ? series : []).forEach((raw) => {
        const value = raw == null ? NaN : Number(raw);
        if (Number.isFinite(value)) {
          latest = value;
          max = max == null || value > max ? value : max;
        }
      });
      stats.set(key, { latest, max });
    });
    return stats;
  }, [heatmap]);

  const sensorRows = useMemo<SensorListRow[]>(() => {
    // The slider's timestamp (smartex heatmap), else the newest value.
    const valueOf = (key: string, fallback: number | null) => {
      if (heatmapIndex != null) {
        const raw = heatmap?.data?.[key]?.[heatmapIndex];
        const value = raw == null ? NaN : Number(raw);
        return Number.isFinite(value) ? value : null;
      }
      return fallback ?? sensorStats.get(key)?.latest ?? null;
    };

    const highest = (values: Array<number | null | undefined>) =>
      values.reduce<number | null>(
        (best, value) => (value != null && (best == null || value > best) ? value : best),
        null,
      );

    // smartex® dm: one row per line, its strongest reading.
    if (hasMeasurePoints && sensorLines.length > 0) {
      return sensorLines.map((line) => ({
        key: line.key,
        label: line.label,
        value: highest(line.points.map((point) => valueOf(String(point.pos), point.last_value ?? null))),
        max: highest(line.points.map((point) => sensorStats.get(String(point.pos))?.max)),
        // The strictest threshold of its sensors.
        threshold:
          line.points.reduce<number | null>(
            (lowest, point) =>
              point.threshold != null && (lowest == null || point.threshold < lowest) ? point.threshold : lowest,
            null,
          ) ?? thresholdValue,
      }));
    }

    if (hasMeasurePoints) {
      return viewPoints.map((point) => {
        const key = String(point.pos);
        return {
          key,
          label: point.name || `#${point.pos}`,
          value: valueOf(key, point.last_value ?? null),
          max: sensorStats.get(key)?.max ?? null,
          threshold: point.threshold ?? thresholdValue,
        };
      });
    }

    return [...sensorStats.keys()]
      .sort((a, b) => Number(a) - Number(b))
      .map((key) => ({
        key,
        label: `#${key}`,
        value: valueOf(key, null),
        max: sensorStats.get(key)?.max ?? null,
        threshold: thresholdValue,
      }));
  }, [hasMeasurePoints, sensorLines, viewPoints, heatmap, heatmapIndex, sensorStats, thresholdValue]);

  // The Verdachtsstellen' latest alarm periods (until now while active),
  // marked on the plan's frame slider.
  const alarmSpans = useMemo<AlarmSpan[]>(() => {
    const now = Date.now();
    const format = (ms: number) =>
      new Date(ms).toLocaleString(undefined, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    return clusters.flatMap((cluster) => {
      const from = cluster.since ? Date.parse(cluster.since) : Number.NaN;
      if (!Number.isFinite(from)) {
        return [];
      }
      const end = cluster.resolved_at ? Date.parse(cluster.resolved_at) : Number.NaN;
      const to = Number.isFinite(end) ? end : now;
      return [{
        key: cluster.id,
        from,
        to,
        label: Number.isFinite(end)
          ? t('status_alarm_span', { sensor: sensorLabel(cluster.sensor_id), from: format(from), to: format(to) })
          : t('status_alarm_span_active', { sensor: sensorLabel(cluster.sensor_id), from: format(from) }),
      }];
    });
  }, [clusters, sensorLabel, t]);

  const objektStatusValue = !worstSeverity
    ? t('status_kpi_ok')
    : t(`ui_severity_${worstSeverity}` as const);
  const objektStatusColor = !worstSeverity
    ? '#3F7A1C'
    : worstSeverity === 'kritisch'
      ? '#C44D26'
      : worstSeverity === 'alarm'
        ? '#EB633B'
        : '#9A7208';

  const kpiTiles = clustersDenied
    ? []
    : [
        {
          label: t('status_kpi_objektstatus'),
          value: objektStatusValue,
          note: openClusters.length
            ? t('status_kpi_note_open', { count: openClusters.length })
            : t('status_kpi_note_none'),
          valueColor: objektStatusColor,
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
            thresholdValue != null
              ? t('status_kpi_max_value_threshold', {
                  threshold: thresholdValue,
                })
              : undefined,
        },
        {
          label: t('status_kpi_anlage'),
          value: isOnline
            ? t('status_kpi_anlage_online')
            : t('status_kpi_anlage_offline'),
          valueColor: isOnline ? '#3F7A1C' : '#8B8383',
        },
      ];

  const toggleExpanded = (clusterId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(clusterId)) {
        next.delete(clusterId);
      } else {
        next.add(clusterId);
      }
      return next;
    });
  };

  const acknowledgeCluster = (cluster: VerdachtsstelleCluster) => {
    if (cluster.pending_ack_alarm_ids.length === 0) {
      return;
    }
    setAcknowledging((prev) => new Set(prev).add(cluster.id));
    Promise.all(
      cluster.pending_ack_alarm_ids.map(
        (alarmId) =>
          new Promise<void>((resolve) => {
            void axiosConfig.perform_post(
              auth,
              // ?location=: alarm ids are only unique within one project database.
              `/v1/alarm/${alarmId}/acknowledge/?location=${locationId}`,
              {},
              () => resolve(),
              (error) => {
                showRequestError(
                  enqueueSnackbar,
                  'Could not acknowledge alarm',
                  error,
                );
                resolve();
              },
            );
          }),
      ),
    ).then(() => {
      setAcknowledging((prev) => {
        const next = new Set(prev);
        next.delete(cluster.id);
        return next;
      });
      loadClusters();
    });
  };

  const addressLine = [
    location?.address,
    [location?.plz, location?.city].filter(Boolean).join(' '),
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
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
            {[
              location?.project_id != null ? `#${location.project_id}` : null,
              getProjectTypeLabel(t, location?.project_type),
            ]
              .filter(Boolean)
              .join(' · ')}
          </div>
          {addressLine && (
            <div style={{ fontSize: 12.5, color: '#8B8383', marginTop: 1 }}>
              {addressLine}
            </div>
          )}
        </div>
        {!isLorawan && !readOnlyDemo && (
          <button
            type="button"
            onClick={requestMeasurement}
            disabled={requestingMeasurement}
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
              cursor: requestingMeasurement ? 'default' : 'pointer',
              boxShadow: '0 4px 14px rgba(235, 99, 59, .28)',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flexShrink: 0,
            }}
          >
            {requestingMeasurement && <Spinner size="sm" animation="border" />}
            {t('status_request_measurement')}
          </button>
        )}
      </div>

      {isLorawan ? (
        <LocationClimatePanels locationId={locationId} demo={demo} />
      ) : (
        <>
          {clustersLoading || heatmapLoading ? (
            <div className="d-flex justify-content-center py-5 text-muted">
              <Spinner animation="border" className="me-2" /> {t('ui_loading')}
            </div>
          ) : (
            kpiTiles.length > 0 && <KpiStrip tiles={kpiTiles} />
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
            <PanelCard title={t('status_zeitreihe_title')}>
              {zeitreiheLoading ? (
                <div className="d-flex justify-content-center py-5 text-muted">
                  <Spinner animation="border" className="me-2" />{' '}
                  {t('ui_loading')}
                </div>
              ) : (
                <ThresholdTrendChart
                  series={zeitreiheSeries}
                  hiddenSeries={hiddenSeries}
                  onToggleSeries={(id) =>
                    setHiddenSeries((prev) => {
                      const next = new Set(prev);
                      if (next.has(id)) {
                        next.delete(id);
                      } else {
                        next.add(id);
                      }
                      return next;
                    })
                  }
                  emptyLabel={t('status_zeitreihe_empty')}
                  meanOfLabel={(count) => t('status_zeitreihe_mean_of', { count })}
                  thresholdLabel={t('status_zeitreihe_threshold_legend')}
                  mutedLabel={(count) =>
                    t('status_zeitreihe_other_sensors', { count })
                  }
                />
              )}
            </PanelCard>
            <LocationBatteryVoltagePanel
              locationId={locationId}
              days={rangeDays}
              demo={demo}
            />
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
                <PanelCard
                  title={t('status_dachansicht_title')}
                  actions={
                    planViews.length > 1 ? (
                      <SegmentedControl
                        options={planViews.map((plan, index) => ({
                          value: String(plan.id),
                          label: plan.name || t('status_plan_view', { index: index + 1 }),
                        }))}
                        value={String(activeLageplan?.id)}
                        onChange={(value) => setSelectedPlanId(Number(value))}
                      />
                    ) : undefined
                  }
                >
                  {heatmapDenied ? (
                    <div style={{ color: '#8B8383', fontSize: 13 }}>
                      {t('status_no_measurement_access')}
                    </div>
                  ) : !hasLageplan ? (
                    <div style={{ color: '#8B8383', fontSize: 13 }}>
                      {t('status_no_lageplan')}
                    </div>
                  ) : !hasMeasurePoints ? (
                    <SensorListTable rows={sensorRows} />
                  ) : visualization !== 'heatmap' ? (
                    <>
                      {heatmap && heatmap.timestamps.length > 0 && heatmapIndex != null && (
                        <div className="px-2 py-2">
                          <FrameSlider
                            id="plan-frame"
                            timestamps={heatmap.timestamps}
                            index={Math.min(heatmapIndex, heatmap.timestamps.length - 1)}
                            onChange={setHeatmapIndex}
                            alarms={alarmSpans}
                          />
                        </div>
                      )}
                      <LageplanZoneOverlay
                        imageUrl={activeLageplan?.url ?? null}
                        points={zonePoints}
                        height={480}
                        mode={visualization}
                      />

                      {withSensorTable && (
                        <div style={{ marginTop: 14 }}>
                          <SensorListTable rows={sensorRows} />
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      <div
                        style={{
                          position: 'relative',
                          borderRadius: 14,
                          background: 'var(--progeo-surface)',
                          overflow: 'hidden',
                        }}
                      >
                        <SensorHeatmap2D
                          response={viewHeatmap}
                          height={480}
                          hideChrome
                          onTimestampChange={setHeatmapIndex}
                          alarms={alarmSpans}
                        />
                      </div>

                      {withSensorTable && (
                        <div style={{ marginTop: 14 }}>
                          <SensorListTable rows={sensorRows} />
                        </div>
                      )}
                    </>
                  )}
                </PanelCard>
              </div>

              <div style={{ flex: '1 1 380px', minWidth: 0 }}>
                <PanelCard
                  title={t('status_verdachtsstellen_title')}
                  actions={
                    demo ? undefined : (
                      <a
                        href="#"
                        onClick={(event) => {
                          event.preventDefault();
                          navigate(`/location/${locationId}/alarms`);
                        }}
                        style={{
                          fontSize: 12.5,
                          color: 'var(--progeo-orange)',
                          fontWeight: 500,
                        }}
                      >
                        {t('status_view_all')}
                      </a>
                    )
                  }
                >
                  {clustersDenied ? (
                    <div style={{ color: '#8B8383', fontSize: 13 }}>
                      {t('status_no_measurement_access')}
                    </div>
                  ) : clusters.length === 0 ? (
                    <div
                      style={{
                        background: 'var(--progeo-surface)',
                        borderRadius: 14,
                        padding: '22px 16px',
                        fontSize: 13,
                        color: '#8B8383',
                      }}
                    >
                      {t('status_verdachtsstellen_empty')}
                    </div>
                  ) : (
                    <div
                      style={{ display: 'flex', flexDirection: 'column', gap: 2 }}
                    >
                      {clusters.map((cluster) => (
                        <VerdachtsstelleRow
                          key={cluster.id}
                          cluster={cluster}
                          label={sensorLabel(cluster.sensor_id)}
                          meters={metersOf(cluster.sensor_id)}
                          expanded={expanded.has(cluster.id)}
                          onToggle={() => toggleExpanded(cluster.id)}
                          onAcknowledge={() => acknowledgeCluster(cluster)}
                          acknowledging={acknowledging.has(cluster.id)}
                          readOnly={demo}
                          t={t}
                        />
                      ))}
                    </div>
                  )}
                </PanelCard>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};

type VerdachtsstelleRowProps = {
  cluster: VerdachtsstelleCluster;
  label: string;
  /** Position of the leak's sensor in meters (calibrated Lageplan only). */
  meters: [number, number] | null;
  expanded: boolean;
  onToggle: () => void;
  onAcknowledge: () => void;
  acknowledging: boolean;
  /** Demo view: no write actions. */
  readOnly?: boolean;
  t: (key: string, options?: Record<string, unknown>) => string;
};

const formatDate = (value: string) =>
  new Date(value).toLocaleDateString(undefined, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });

const VerdachtsstelleRow = ({
  cluster,
  label,
  meters,
  expanded,
  onToggle,
  onAcknowledge,
  acknowledging,
  readOnly = false,
  t,
}: VerdachtsstelleRowProps) => {
  const hasPendingAck = cluster.pending_ack_alarm_ids.length > 0;

  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          width: '100%',
          textAlign: 'left',
          background: 'none',
          border: 'none',
          padding: '10px 12px',
          borderRadius: 12,
          cursor: 'pointer',
          fontFamily: 'inherit',
        }}
      >
        {expanded ? <ChevronDown /> : <ChevronRight />}
        <span style={{ flex: 1, minWidth: 0 }}>
          <span
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 9,
              flexWrap: 'wrap',
            }}
          >
            <span style={{ fontSize: 14, fontWeight: 500 }}>
              {label}
              {cluster.device_label && (
                <span style={{ fontWeight: 400, color: '#8B8383' }}>
                  {' '}
                  · {cluster.device_label}
                  {cluster.device_type ? ` (${cluster.device_type})` : ''}
                </span>
              )}
            </span>
            <StateBadge
              state={cluster.state}
              label={t(`ui_${cluster.state}`)}
            />
            <SeverityBadge
              severity={cluster.severity}
              label={t(`ui_severity_${cluster.severity}`)}
            />
          </span>
          <span
            style={{
              display: 'block',
              marginTop: 4,
              fontSize: 12.5,
              color: '#8B8383',
            }}
          >
            {cluster.active
              ? cluster.since &&
                t('status_since', { date: formatDate(cluster.since) })
              : cluster.resolved_at &&
                t('status_resolved_at', {
                  date: formatDate(cluster.resolved_at),
                })}
            {meters && ` · ${formatMeters(meters)}`}
          </span>
        </span>
        <span
          style={{
            fontSize: 13.5,
            fontWeight: 600,
            color: 'var(--progeo-orange)',
          }}
        >
          {cluster.max_value != null
            ? t('status_peak_value', { value: Math.round(cluster.max_value) })
            : '–'}
        </span>
      </button>

      {expanded && (
        <div
          style={{
            padding: '0 14px 14px 36px',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          <div
            style={{
              fontSize: 10.5,
              letterSpacing: '.09em',
              textTransform: 'uppercase',
              color: '#8B8383',
              fontWeight: 500,
            }}
          >
            {t('status_alarm_history')}
          </div>
          <div
            style={{
              background: 'var(--progeo-surface)',
              borderRadius: 11,
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1.3fr 1fr 1fr',
                padding: '9px 12px',
                fontSize: 10.5,
                letterSpacing: '.06em',
                textTransform: 'uppercase',
                color: '#8B8383',
                fontWeight: 500,
              }}
            >
              <span>{t('status_col_date')}</span>
              <span>{t('status_col_state')}</span>
              <span>{t('status_col_value')}</span>
            </div>
            {cluster.alarms.map((entry) => (
              <div
                key={entry.id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1.3fr 1fr 1fr',
                  padding: '9px 12px',
                  fontSize: 12.5,
                  borderTop: '1px solid var(--progeo-track-soft)',
                }}
              >
                <span style={{ fontWeight: 500 }}>
                  {entry.triggered_at
                    ? new Date(entry.triggered_at).toLocaleString(undefined, {
                        day: '2-digit',
                        month: '2-digit',
                        year: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })
                    : '–'}
                </span>
                <span>
                  <StateBadge
                    state={entry.state}
                    label={t(`ui_${entry.state}`)}
                  />
                </span>
                <span
                  style={{ fontWeight: 600, color: 'var(--progeo-orange)' }}
                >
                  {entry.value != null ? `${Math.round(entry.value)} mV` : '–'}
                </span>
              </div>
            ))}
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              flexWrap: 'wrap',
            }}
          >
            <button
              type="button"
              hidden={readOnly}
              onClick={onAcknowledge}
              disabled={!hasPendingAck || acknowledging}
              style={{
                height: 34,
                padding: '0 14px',
                border: 'none',
                borderRadius: 10,
                background: hasPendingAck
                  ? 'var(--progeo-orange)'
                  : 'var(--progeo-track-soft)',
                color: hasPendingAck ? '#fff' : '#8B8383',
                fontFamily: 'inherit',
                fontSize: 13,
                fontWeight: 500,
                cursor: hasPendingAck && !acknowledging ? 'pointer' : 'default',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              {acknowledging ? (
                <Spinner size="sm" animation="border" />
              ) : (
                <CheckLg size={14} />
              )}
              <span>{t('ui_quittieren')}</span>
            </button>
            {cluster.ack_by && (
              <span style={{ fontSize: 11.5, color: '#8B8383' }}>
                {t('status_acknowledged_by', {
                  name: cluster.ack_by,
                  time: cluster.ack_at
                    ? new Date(cluster.ack_at).toLocaleString()
                    : '–',
                })}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default LocationStatusView;
