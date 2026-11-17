import { useState } from 'react';
import { Spinner } from 'react-bootstrap';
import { CheckLg, ChevronDown, ChevronRight } from 'react-bootstrap-icons';
import { useTranslation } from 'react-i18next';
import { formatMeters } from '../components/device/planMeters';
import PanelCard from '../components/ui/kit/PanelCard';
import SegmentedControl from '../components/ui/kit/SegmentedControl';
import SeverityBadge from '../components/ui/kit/SeverityBadge';
import StateBadge from '../components/ui/kit/StateBadge';
import {
  pointLetter,
  sensorList,
  type ComputedSuspicionPoint,
  type SuspicionMode,
} from './computedSuspicion';
import { formatDate } from './dateFormat';
import { toggledSet } from './locationStatusData';
import { repeatedTestId } from '../testIds';
import './VerdachtsstellenPanel.css';
import './ComputedSuspicionPanel.css';

/** Staff: computed points or the per-sensor Verdachtsstellen (mx-PEEL only). */
export const SuspicionModeSwitch = ({
  mode,
  onChange,
}: {
  mode: SuspicionMode;
  onChange: (mode: SuspicionMode) => void;
}) => {
  const { t } = useTranslation();
  return (
    <div className="computed-suspicion-mode">
      <SegmentedControl
        testId="suspicion-mode"
        options={[
          {
            value: 'computed',
            label: t('suspicion_mode_computed'),
            title: t('suspicion_mode_computed_hint'),
          },
          { value: 'sensors', label: t('suspicion_mode_sensors') },
        ]}
        value={mode}
        onChange={(value) => onChange(value as SuspicionMode)}
      />
    </div>
  );
};

type ComputedSuspicionPanelProps = {
  points: ComputedSuspicionPoint[];
  loading: boolean;
  /** No permission to see the location's alarms. */
  denied: boolean;
  sensorLabel: (sensorId: number) => string;
  acknowledging: Set<string>;
  onAcknowledge: (point: ComputedSuspicionPoint) => void;
  /** Demo view: no write actions. */
  readOnly: boolean;
};

/**
 * smartex® mx-PEEL: the computed suspicion points of the selected range -
 * the places a leak most likely is, aggregated from the sensors over their
 * threshold (computedSuspicion.ts). Each row is lettered like its ring on
 * the plan and expands to its sensors and the acknowledgement.
 */
const ComputedSuspicionPanel = ({
  points,
  loading,
  denied,
  sensorLabel,
  acknowledging,
  onAcknowledge,
  readOnly,
}: ComputedSuspicionPanelProps) => {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const body = () => {
    if (denied) {
      return (
        <div
          className="verdachtsstellen-denied"
          data-testid="computed-suspicion-denied"
        >
          {t('status_no_measurement_access')}
        </div>
      );
    }
    if (loading && points.length === 0) {
      return (
        <Spinner
          size="sm"
          animation="border"
          data-testid="computed-suspicion-loading"
        />
      );
    }
    if (points.length === 0) {
      return (
        <div
          className="verdachtsstellen-empty"
          data-testid="computed-suspicion-empty"
        >
          {t('suspicion_computed_empty')}
        </div>
      );
    }
    return (
      <div
        className="verdachtsstellen-list"
        data-testid="computed-suspicion-list"
      >
        {points.map((point, index) => (
          <ComputedSuspicionRow
            key={point.id}
            point={point}
            letter={pointLetter(index)}
            sensors={sensorList(point.sensor_ids, sensorLabel)}
            expanded={expanded.has(point.id)}
            onToggle={() => setExpanded((prev) => toggledSet(prev, point.id))}
            onAcknowledge={() => onAcknowledge(point)}
            acknowledging={acknowledging.has(point.id)}
            readOnly={readOnly}
            sensorLabel={sensorLabel}
          />
        ))}
      </div>
    );
  };

  return (
    <PanelCard
      testId="computed-suspicion"
      title={t('suspicion_computed_title')}
    >
      <div className="computed-suspicion-hint">
        {t('suspicion_computed_hint')}
      </div>
      {body()}
    </PanelCard>
  );
};

type ComputedSuspicionRowProps = {
  point: ComputedSuspicionPoint;
  letter: string;
  sensors: string;
  expanded: boolean;
  onToggle: () => void;
  onAcknowledge: () => void;
  acknowledging: boolean;
  readOnly: boolean;
  sensorLabel: (sensorId: number) => string;
};

const ComputedSuspicionRow = ({
  point,
  letter,
  sensors,
  expanded,
  onToggle,
  onAcknowledge,
  acknowledging,
  readOnly,
  sensorLabel,
}: ComputedSuspicionRowProps) => {
  const { t } = useTranslation();
  const hasPendingAck = point.pending_ack_alarm_ids.length > 0;
  const meters: [number, number] | null =
    point.x_m != null && point.y_m != null ? [point.x_m, point.y_m] : null;

  return (
    <div {...repeatedTestId('computed-suspicion-row', point.id)}>
      <button
        type="button"
        onClick={onToggle}
        className="verdachtsstellen-row-toggle"
        {...repeatedTestId('computed-suspicion-toggle', point.id)}
      >
        {expanded ? <ChevronDown /> : <ChevronRight />}
        <span
          className={`computed-suspicion-letter computed-suspicion-letter--${point.state}`}
        >
          {letter}
        </span>
        <span className="verdachtsstellen-row-main">
          <span className="verdachtsstellen-row-head">
            <span className="verdachtsstellen-row-label">
              {t('suspicion_computed_point', {
                count: point.sensor_ids.length,
              })}
            </span>
            <StateBadge state={point.state} label={t(`ui_${point.state}`)} />
            {point.severity && (
              <SeverityBadge
                severity={point.severity}
                label={t(`ui_severity_${point.severity}`)}
              />
            )}
          </span>
          <span className="verdachtsstellen-row-meta">
            {sensors}
            {point.last_seen &&
              ` · ${t('suspicion_last_seen', { date: formatDate(point.last_seen, 'date') })}`}
            {meters && ` · ${formatMeters(meters)}`}
          </span>
        </span>
        <span
          className="verdachtsstellen-row-peak"
          {...repeatedTestId('computed-suspicion-peak', point.id)}
        >
          {point.max_value != null
            ? t('status_peak_value', { value: Math.round(point.max_value) })
            : '–'}
        </span>
      </button>

      {expanded && (
        <div
          className="verdachtsstellen-details"
          {...repeatedTestId('computed-suspicion-details', point.id)}
        >
          <div className="computed-suspicion-facts">
            <span>
              {t('suspicion_strength', {
                value: Math.round(point.strength * 100),
              })}
            </span>
            {point.max_exceedance != null && (
              <span>
                {t('suspicion_exceedance', {
                  value: point.max_exceedance.toFixed(1),
                })}
              </span>
            )}
            {point.first_seen && (
              <span>
                {t('suspicion_first_seen', {
                  date: formatDate(point.first_seen),
                })}
              </span>
            )}
            <span>{t('suspicion_readings', { count: point.readings })}</span>
          </div>
          <div className="verdachtsstellen-details-title">
            {t('suspicion_member_sensors')}
          </div>
          <div className="computed-suspicion-sensors">
            {point.sensor_ids.map((sensorId) => (
              <span key={sensorId} className="computed-suspicion-sensor">
                {sensorLabel(sensorId)}
              </span>
            ))}
          </div>
          <div className="verdachtsstellen-actions">
            <button
              type="button"
              hidden={readOnly}
              onClick={onAcknowledge}
              {...repeatedTestId('computed-suspicion-acknowledge', point.id)}
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
          </div>
        </div>
      )}
    </div>
  );
};

export default ComputedSuspicionPanel;
