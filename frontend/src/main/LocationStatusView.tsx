import { useCallback, useEffect, useMemo, useState } from 'react';
import { Spinner } from 'react-bootstrap';
import { ChevronDown, ChevronRight, CheckLg } from 'react-bootstrap-icons';
import { useSnackbar } from 'notistack';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig';
import { showErrorBar, showSuccessBar } from '../components/ui/Snackbar.jsx';
import SensorHeatmap2D from '../components/device/SensorHeatmap2D';
import type { SensorHeatmapResponse } from '../components/device/SensorHeatmap3D';
import { plotTheme } from '../styles/plotTheme';
import PanelCard from '../components/ui/kit/PanelCard';
import KpiStrip from '../components/ui/kit/KpiStrip';
import LegendGradientBar from '../components/ui/kit/LegendGradientBar';
import StateBadge, { type AlarmState } from '../components/ui/kit/StateBadge';
import SeverityBadge, {
  type Severity,
} from '../components/ui/kit/SeverityBadge';
import Tooltip from '../components/ui/kit/Tooltip';
import type { LocationDetail } from './locationTypes';
import { getProjectTypeLabel } from './projectType';

type LocationStatusViewProps = {
  location: LocationDetail | null;
  locationId: number;
};

// The backend now owns severity/state/clustering entirely
// (ProgeoAlarm.severity, the auto-GELOEST transition, and
// AlarmViewSet.clusters) - this view just renders what it returns.
type VerdachtsstelleCluster = {
  id: string;
  device_id: number;
  device_label: string;
  device_type: string | null;
  alarm_ids: number[];
  state: AlarmState;
  severity: Severity;
  max_value: number | null;
  since: string | null;
  ack_by: string | null;
  ack_at: string | null;
  pending_ack_alarm_ids: number[];
  sensors: { sensor_id: number | null; max_value: number | null }[];
};

const HEATMAP_LIMIT = 200;
const ALARM_WINDOW_DAYS = 90;
const SEVERITY_ORDER: Record<Severity, number> = {
  beobachten: 0,
  alarm: 1,
  kritisch: 2,
};

const LocationStatusView = ({
  location,
  locationId,
}: LocationStatusViewProps) => {
  const auth = useAuth();
  const navigate = useNavigate();
  const { enqueueSnackbar } = useSnackbar();
  const { t } = useTranslation();

  const [heatmap, setHeatmap] = useState<SensorHeatmapResponse | null>(null);
  const [heatmapLoading, setHeatmapLoading] = useState(true);
  const [heatmapDenied, setHeatmapDenied] = useState(false);

  const [clusters, setClusters] = useState<VerdachtsstelleCluster[]>([]);
  const [clustersLoading, setClustersLoading] = useState(true);
  const [clustersDenied, setClustersDenied] = useState(false);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [acknowledging, setAcknowledging] = useState<Set<string>>(new Set());
  const [requestingMeasurement, setRequestingMeasurement] = useState(false);

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
        const reason = error?.response?.data?.reason || error.message;
        showErrorBar(
          enqueueSnackbar,
          t('status_request_measurement_error', { reason }),
        );
        setRequestingMeasurement(false);
      },
    );
  };

  const loadHeatmap = useCallback(() => {
    setHeatmapLoading(true);
    setHeatmapDenied(false);
    void axiosConfig.perform_get(
      auth,
      `/v1/location/${locationId}/heatmap/?limit=${HEATMAP_LIMIT}`,
      (response) => {
        setHeatmap((response?.data || null) as SensorHeatmapResponse | null);
        setHeatmapLoading(false);
      },
      (error) => {
        if (error?.response?.status === 403) {
          setHeatmapDenied(true);
        } else {
          const reason = error?.response?.data?.reason || error.message;
          showErrorBar(enqueueSnackbar, `Could not load heatmap: ${reason}`);
        }
        setHeatmapLoading(false);
      },
    );
  }, [auth, enqueueSnackbar, locationId]);

  const loadClusters = useCallback(() => {
    setClustersLoading(true);
    setClustersDenied(false);
    void axiosConfig.perform_get(
      auth,
      `/v1/alarm/clusters/?location=${locationId}&days=${ALARM_WINDOW_DAYS}`,
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
          const reason = error?.response?.data?.reason || error.message;
          showErrorBar(
            enqueueSnackbar,
            `Could not load suspected leaks: ${reason}`,
          );
        }
        setClustersLoading(false);
      },
    );
  }, [auth, enqueueSnackbar, locationId]);

  useEffect(() => {
    loadHeatmap();
    loadClusters();
  }, [loadHeatmap, loadClusters]);

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

  const isOnline = (heatmap?.timestamps?.length ?? 0) > 0;
  const thresholdValue = location?.alarm_threshold ?? null;

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
              `/v1/alarm/${alarmId}/acknowledge/`,
              {},
              () => resolve(),
              (error) => {
                const reason = error?.response?.data?.reason || error.message;
                showErrorBar(
                  enqueueSnackbar,
                  `Could not acknowledge alarm: ${reason}`,
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
              fontSize: 17,
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
      </div>

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
          gap: 14,
          alignItems: 'flex-start',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ flex: '1 1 560px', minWidth: 0 }}>
          <PanelCard title={t('status_dachansicht_title')}>
            {heatmapDenied ? (
              <div style={{ color: '#8B8383', fontSize: 13 }}>
                {t('status_no_measurement_access')}
              </div>
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
                  <SensorHeatmap2D response={heatmap} height={480} hideChrome />
                </div>
                <div style={{ marginTop: 14 }}>
                  <LegendGradientBar
                    title={t('status_legend_title')}
                    stops={[
                      plotTheme.brandBlue,
                      plotTheme.contrastCyan,
                      plotTheme.contrastYellow,
                      plotTheme.brandOrange,
                    ]}
                    ticks={
                      thresholdValue
                        ? [
                            '0 mV',
                            `${thresholdValue} mV`,
                            `${thresholdValue * 3} mV`,
                          ]
                        : ['0 mV']
                    }
                  />
                </div>
              </>
            )}
          </PanelCard>
        </div>

        <div style={{ flex: '1 1 380px', minWidth: 0 }}>
          <PanelCard
            title={t('status_verdachtsstellen_title')}
            actions={
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
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {clusters.map((cluster) => (
                  <VerdachtsstelleRow
                    key={cluster.id}
                    cluster={cluster}
                    expanded={expanded.has(cluster.id)}
                    onToggle={() => toggleExpanded(cluster.id)}
                    onAcknowledge={() => acknowledgeCluster(cluster)}
                    acknowledging={acknowledging.has(cluster.id)}
                    t={t}
                  />
                ))}
              </div>
            )}
          </PanelCard>
        </div>
      </div>
    </div>
  );
};

type VerdachtsstelleRowProps = {
  cluster: VerdachtsstelleCluster;
  expanded: boolean;
  onToggle: () => void;
  onAcknowledge: () => void;
  acknowledging: boolean;
  t: (key: string, options?: Record<string, unknown>) => string;
};

const VerdachtsstelleRow = ({
  cluster,
  expanded,
  onToggle,
  onAcknowledge,
  acknowledging,
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
              {cluster.device_label}
              {cluster.device_type && (
                <span style={{ fontWeight: 400, color: '#8B8383' }}>
                  {' '}
                  ({cluster.device_type})
                </span>
              )}
            </span>
            {cluster.alarm_ids.length > 0 && (
              <span style={{ fontSize: 11.5, fontWeight: 400, color: '#8B8383' }}>
                {t('status_alarm_ids', {
                  ids: cluster.alarm_ids.map((id) => `#${id}`).join(', '),
                })}
              </span>
            )}
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
            {cluster.since &&
              t('status_since', {
                date: new Date(cluster.since).toLocaleDateString(undefined, {
                  day: '2-digit',
                  month: '2-digit',
                  year: 'numeric',
                }),
              })}
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
            ? `${Math.round(cluster.max_value)} mV`
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
            {t('status_affected_points')}
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
                gridTemplateColumns: '1fr 1fr 1.4fr',
                padding: '9px 12px',
                fontSize: 10.5,
                letterSpacing: '.06em',
                textTransform: 'uppercase',
                color: '#8B8383',
                fontWeight: 500,
              }}
            >
              <Tooltip title={t('status_col_mp_tooltip')}>
                {t('status_col_mp')}
              </Tooltip>
              <Tooltip title={t('status_col_avgwp_tooltip')}>
                {t('status_col_avgwp')}
              </Tooltip>
              <span>{t('status_col_position')}</span>
            </div>
            {cluster.sensors.map((sensor, index) => (
              <div
                key={`${sensor.sensor_id ?? index}`}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr 1.4fr',
                  padding: '9px 12px',
                  fontSize: 12.5,
                  borderTop: '1px solid var(--progeo-track-soft)',
                }}
              >
                <span style={{ fontWeight: 600 }}>
                  #{sensor.sensor_id ?? '–'}
                </span>
                <span
                  style={{ fontWeight: 600, color: 'var(--progeo-orange)' }}
                >
                  {sensor.max_value ?? '–'}
                </span>
                <span style={{ color: '#8B8383' }}>
                  {sensor.sensor_id != null && sensor.max_value != null
                    ? t('status_col_position_value', {
                        sensor: sensor.sensor_id,
                        value: sensor.max_value,
                      })
                    : '–'}
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
