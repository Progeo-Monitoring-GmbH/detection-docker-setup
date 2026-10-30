import { useState } from 'react';
import { Spinner } from 'react-bootstrap';
import { ChevronDown, ChevronRight, CheckLg } from 'react-bootstrap-icons';
import { useTranslation } from 'react-i18next';
import { formatMeters } from '../components/device/planMeters';
import PanelCard from '../components/ui/kit/PanelCard';
import SeverityBadge from '../components/ui/kit/SeverityBadge';
import StateBadge from '../components/ui/kit/StateBadge';
import { toggledSet, type VerdachtsstelleCluster } from './locationStatusData';
import { formatDate } from './dateFormat';

type VerdachtsstellenPanelProps = {
  clusters: VerdachtsstelleCluster[];
  /** No permission to see the location's alarms. */
  denied: boolean;
  sensorLabel: (sensorId: number) => string;
  /** Position of a sensor in meters (calibrated Lageplan only). */
  metersOf: (sensorId: number) => [number, number] | null;
  acknowledging: Set<string>;
  onAcknowledge: (cluster: VerdachtsstelleCluster) => void;
  /** Link to every alarm of the location; none in the demo view. */
  onViewAll?: () => void;
  /** Demo view: no write actions. */
  readOnly: boolean;
};

/** The Verdachtsstellen (suspected leaks) of the location, each expandable
 * to its alarm history and acknowledgement. */
const VerdachtsstellenPanel = ({
  clusters,
  denied,
  sensorLabel,
  metersOf,
  acknowledging,
  onAcknowledge,
  onViewAll,
  readOnly,
}: VerdachtsstellenPanelProps) => {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  return (
    <PanelCard
      title={t('status_verdachtsstellen_title')}
      actions={
        onViewAll && (
          <a
            href="#"
            onClick={(event) => {
              event.preventDefault();
              onViewAll();
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
      {denied ? (
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
              label={sensorLabel(cluster.sensor_id)}
              meters={metersOf(cluster.sensor_id)}
              expanded={expanded.has(cluster.id)}
              onToggle={() => setExpanded((prev) => toggledSet(prev, cluster.id))}
              onAcknowledge={() => onAcknowledge(cluster)}
              acknowledging={acknowledging.has(cluster.id)}
              readOnly={readOnly}
              t={t}
            />
          ))}
        </div>
      )}
    </PanelCard>
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
                t('status_since', { date: formatDate(cluster.since, 'date') })
              : cluster.resolved_at &&
                t('status_resolved_at', {
                  date: formatDate(cluster.resolved_at, 'date'),
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
                  {formatDate(entry.triggered_at)}
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
                  time: formatDate(cluster.ack_at),
                })}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default VerdachtsstellenPanel;
