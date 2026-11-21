import { useState, type ReactNode } from 'react';
import { Spinner } from 'react-bootstrap';
import { ChevronDown, ChevronRight, CheckLg } from 'react-bootstrap-icons';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { formatMeters } from '../components/device/planMeters';
import ConfirmDialog from '../components/ui/kit/ConfirmDialog';
import PanelCard from '../components/ui/kit/PanelCard';
import SeverityBadge from '../components/ui/kit/SeverityBadge';
import StateBadge from '../components/ui/kit/StateBadge';
import { splitResolved, toggledSet, type VerdachtsstelleCluster } from './locationStatusData';
import { formatDate } from './dateFormat';
import AlarmHistoryTable from './AlarmHistoryTable';
import { repeatedTestId } from '../testIds';
import './VerdachtsstellenPanel.css';

type VerdachtsstellenPanelProps = {
  clusters: VerdachtsstelleCluster[];
  /** No permission to see the location's alarms. */
  denied: boolean;
  sensorLabel: (sensorId: number) => string;
  /** Position of a sensor in meters (calibrated Lageplan only). */
  metersOf: (sensorId: number) => [number, number] | null;
  /** The sensor is switched off (disabledSensors.ts): its row is gray. */
  disabledOf?: (sensorId: number) => boolean;
  acknowledging: Set<string>;
  onAcknowledge: (cluster: VerdachtsstelleCluster) => void;
  /** Demo view: no write actions. */
  readOnly: boolean;
  /** Right of the title (the staff's Berechnet / Je Sensor switch). */
  headerActions?: ReactNode;
};

/** The Verdachtsstellen (suspected leaks) of the location, each expandable
 * to its alarm history and acknowledgement. Resolved ones are not in the
 * default view: they wait in a collapsed "Resolved (n)" section. */
const VerdachtsstellenPanel = ({
  clusters,
  denied,
  sensorLabel,
  metersOf,
  disabledOf,
  acknowledging,
  onAcknowledge,
  readOnly,
  headerActions,
}: VerdachtsstellenPanelProps) => {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showResolved, setShowResolved] = useState(false);
  // The cluster whose pending alarms wait for the confirmation to be acknowledged.
  const [ackTarget, setAckTarget] = useState<VerdachtsstelleCluster | null>(null);
  const { open, resolved } = splitResolved(clusters);

  const rows = (list: VerdachtsstelleCluster[]) =>
    list.map((cluster) => (
      <VerdachtsstelleRow
        key={cluster.id}
        cluster={cluster}
        label={sensorLabel(cluster.sensor_id)}
        meters={metersOf(cluster.sensor_id)}
        disabled={disabledOf?.(cluster.sensor_id) ?? false}
        expanded={expanded.has(cluster.id)}
        onToggle={() => setExpanded((prev) => toggledSet(prev, cluster.id))}
        onAcknowledge={() => setAckTarget(cluster)}
        acknowledging={acknowledging.has(cluster.id)}
        readOnly={readOnly}
        t={t}
      />
    ));

  return (
    <PanelCard
      testId="verdachtsstellen"
      title={t('status_verdachtsstellen_title')}
      actions={headerActions}
    >
      {denied ? (
        <div className="verdachtsstellen-denied" data-testid="verdachtsstellen-denied">
          {t('status_no_measurement_access')}
        </div>
      ) : (
        <>
          {open.length === 0 ? (
            <div className="verdachtsstellen-empty" data-testid="verdachtsstellen-empty">
              {t('status_verdachtsstellen_empty')}
            </div>
          ) : (
            <div className="verdachtsstellen-list" data-testid="verdachtsstellen-list">
              {rows(open)}
            </div>
          )}
          {resolved.length > 0 && (
            <div className="verdachtsstellen-resolved" data-testid="verdachtsstellen-resolved">
              <button
                type="button"
                onClick={() => setShowResolved((shown) => !shown)}
                aria-expanded={showResolved}
                className="verdachtsstellen-resolved-toggle"
                data-testid="verdachtsstellen-resolved-toggle"
              >
                {showResolved ? <ChevronDown /> : <ChevronRight />}
                {t('status_verdachtsstellen_resolved', { count: resolved.length })}
              </button>
              {showResolved && (
                <div className="verdachtsstellen-list" data-testid="verdachtsstellen-resolved-list">
                  {rows(resolved)}
                </div>
              )}
            </div>
          )}
        </>
      )}
      <ConfirmDialog
        testId="verdachtsstelle-acknowledge-dialog"
        show={ackTarget !== null}
        title={t('acknowledge_alarms_title')}
        message={t('acknowledge_alarms_verdachtsstelle_message', {
          count: ackTarget?.pending_ack_alarm_ids.length ?? 0,
          sensor: ackTarget ? sensorLabel(ackTarget.sensor_id) : '',
        })}
        confirmLabel={t('ui_quittieren')}
        cancelLabel={t('acknowledge_alarms_cancel')}
        danger={false}
        onCancel={() => setAckTarget(null)}
        onConfirm={() => {
          if (ackTarget) {
            onAcknowledge(ackTarget);
          }
          setAckTarget(null);
        }}
      />
    </PanelCard>
  );
};

type VerdachtsstelleRowProps = {
  cluster: VerdachtsstelleCluster;
  label: string;
  /** Position of the leak's sensor in meters (calibrated Lageplan only). */
  meters: [number, number] | null;
  /** The sensor is switched off: the row is gray, with a note. */
  disabled?: boolean;
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
  disabled = false,
  expanded,
  onToggle,
  onAcknowledge,
  acknowledging,
  readOnly = false,
  t,
}: VerdachtsstelleRowProps) => {
  const hasPendingAck = cluster.pending_ack_alarm_ids.length > 0;

  return (
    <div
      className={disabled ? 'verdachtsstellen-row--disabled' : undefined}
      {...repeatedTestId('verdachtsstelle', cluster.id)}
    >
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
            {disabled && ` · ${t('status_sensor_table_disabled_hint')}`}
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
          <AlarmHistoryTable
            entries={cluster.alarms}
            testId={`verdachtsstelle-history-${cluster.id}`}
            rowTestId="verdachtsstelle-history-row"
          />
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
