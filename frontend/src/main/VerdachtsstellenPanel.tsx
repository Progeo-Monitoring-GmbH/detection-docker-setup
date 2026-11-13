import { useState } from 'react';
import { Spinner } from 'react-bootstrap';
import { ChevronDown, ChevronRight, CheckLg } from 'react-bootstrap-icons';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { formatMeters } from '../components/device/planMeters';
import PanelCard from '../components/ui/kit/PanelCard';
import SeverityBadge from '../components/ui/kit/SeverityBadge';
import StateBadge from '../components/ui/kit/StateBadge';
import { toggledSet, type VerdachtsstelleCluster } from './locationStatusData';
import { formatDate } from './dateFormat';
import { repeatedTestId } from '../testIds';
import './VerdachtsstellenPanel.css';

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
      testId="verdachtsstellen"
      title={t('status_verdachtsstellen_title')}
      actions={
        onViewAll && (
          <a
            href="#"
            onClick={(event) => {
              event.preventDefault();
              onViewAll();
            }}
            className="verdachtsstellen-view-all"
            data-testid="verdachtsstellen-view-all"
          >
            {t('status_view_all')}
          </a>
        )
      }
    >
      {denied ? (
        <div className="verdachtsstellen-denied" data-testid="verdachtsstellen-denied">
          {t('status_no_measurement_access')}
        </div>
      ) : clusters.length === 0 ? (
        <div className="verdachtsstellen-empty" data-testid="verdachtsstellen-empty">
          {t('status_verdachtsstellen_empty')}
        </div>
      ) : (
        <div className="verdachtsstellen-list" data-testid="verdachtsstellen-list">
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
  t: TFunction;
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
    <div {...repeatedTestId('verdachtsstelle', cluster.id)}>
      <button
        type="button"
        onClick={onToggle}
        className="verdachtsstellen-row-toggle"
        {...repeatedTestId('verdachtsstelle-toggle', cluster.id)}
      >
        {expanded ? <ChevronDown /> : <ChevronRight />}
        <span className="verdachtsstellen-row-main">
          <span className="verdachtsstellen-row-head">
            <span className="verdachtsstellen-row-label">
              {label}
              {cluster.device_label && (
                <span className="verdachtsstellen-row-device">
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
          <span className="verdachtsstellen-row-meta">
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
        <span className="verdachtsstellen-row-peak" {...repeatedTestId('verdachtsstelle-peak', cluster.id)}>
          {cluster.max_value != null
            ? t('status_peak_value', { value: Math.round(cluster.max_value) })
            : '–'}
        </span>
      </button>

      {expanded && (
        <div className="verdachtsstellen-details" {...repeatedTestId('verdachtsstelle-details', cluster.id)}>
          <div className="verdachtsstellen-details-title">
            {t('status_alarm_history')}
          </div>
          <div className="verdachtsstellen-history">
            <div className="verdachtsstellen-history-head">
              <span>{t('status_col_date')}</span>
              <span>{t('status_col_state')}</span>
              <span>{t('status_col_value')}</span>
            </div>
            {cluster.alarms.map((entry) => (
              <div
                key={entry.id}
                className="verdachtsstellen-history-row"
                {...repeatedTestId('verdachtsstelle-history-row', entry.id)}
              >
                <span className="verdachtsstellen-history-date">
                  {formatDate(entry.triggered_at)}
                </span>
                <span>
                  <StateBadge
                    state={entry.state}
                    label={t(`ui_${entry.state}`)}
                  />
                </span>
                <span className="verdachtsstellen-history-value">
                  {entry.value != null ? `${Math.round(entry.value)} mV` : '–'}
                </span>
              </div>
            ))}
          </div>
          <div className="verdachtsstellen-actions">
            <button
              type="button"
              hidden={readOnly}
              onClick={onAcknowledge}
              {...repeatedTestId('verdachtsstelle-acknowledge', cluster.id)}
              disabled={!hasPendingAck || acknowledging}
              className={`verdachtsstellen-ack${hasPendingAck ? ' verdachtsstellen-ack--pending' : ''}`}
            >
              {acknowledging ? (
                <Spinner size="sm" animation="border" />
              ) : (
                <CheckLg size={14} />
              )}
              <span>{t('ui_quittieren')}</span>
            </button>
            {cluster.ack_by && (
              <span className="verdachtsstellen-ack-by" {...repeatedTestId('verdachtsstelle-ack-by', cluster.id)}>
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
