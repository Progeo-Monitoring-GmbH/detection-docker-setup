import { useState, type ReactNode } from 'react';
import { Spinner } from 'react-bootstrap';
import {
  CheckLg,
  ChevronDown,
  ChevronRight,
  ClockHistory,
  SkipBackwardFill,
} from 'react-bootstrap-icons';
import { useTranslation } from 'react-i18next';
import { formatMeters } from '../components/device/planMeters';
import BoldTrans from '../components/ui/kit/BoldTrans';
import ConfirmDialog from '../components/ui/kit/ConfirmDialog';
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
import AlarmHistoryTable from './AlarmHistoryTable';
import { toggledSet } from './locationStatusData';
import { repeatedTestId } from '../testIds';
import './VerdachtsstellenPanel.css';
import './ComputedSuspicionPanel.css';

/** Staff: computed points or the per-sensor Verdachtsstellen - in the panel's header. */
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
  /** Right of the title (the staff's Berechnet / Je Sensor switch). */
  headerActions?: ReactNode;
  /** A member sensor hovered (null: left) - the plan points it out. */
  onSensorHover?: (sensorId: number | null) => void;
  /** Sets the plan's time slider to a moment (ISO-8601) - the detection
   * ("Jump to Event") - and the plan to the point's. */
  onShowMoment?: (at: string, plan?: number | null) => void;
};

/**
 * The computed suspicion points of the selected range (every product) -
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
  headerActions,
  onSensorHover,
  onShowMoment,
}: ComputedSuspicionPanelProps) => {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // The point whose pending alarms wait for the confirmation to be acknowledged.
  const [ackTarget, setAckTarget] = useState<{
    point: ComputedSuspicionPoint;
    letter: string;
  } | null>(null);

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
            onAcknowledge={() =>
              setAckTarget({ point, letter: pointLetter(index) })
            }
            acknowledging={acknowledging.has(point.id)}
            readOnly={readOnly}
            sensorLabel={sensorLabel}
            onSensorHover={onSensorHover}
            onShowMoment={onShowMoment}
          />
        ))}
      </div>
    );
  };

  return (
    <PanelCard
      testId="computed-suspicion"
      title={t('suspicion_computed_title')}
      actions={headerActions}
    >
      <div className="computed-suspicion-hint">
        {t('suspicion_computed_hint')}
      </div>
      {body()}
      <ConfirmDialog
        testId="computed-suspicion-acknowledge-dialog"
        show={ackTarget !== null}
        title={t('acknowledge_alarms_title')}
        message={
          <BoldTrans
            i18nKey="acknowledge_alarms_point_message"
            values={{
              count: ackTarget?.point.pending_ack_alarm_ids.length ?? 0,
              letter: ackTarget?.letter ?? '',
              sensors: ackTarget?.point.sensor_ids.length ?? 0,
            }}
          />
        }
        confirmLabel={t('ui_quittieren')}
        cancelLabel={t('acknowledge_alarms_cancel')}
        danger={false}
        onCancel={() => setAckTarget(null)}
        onConfirm={() => {
          if (ackTarget) {
            onAcknowledge(ackTarget.point);
          }
          setAckTarget(null);
        }}
      />
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
  onSensorHover?: (sensorId: number | null) => void;
  onShowMoment?: (at: string, plan?: number | null) => void;
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
  onSensorHover,
  onShowMoment,
}: ComputedSuspicionRowProps) => {
  const { t } = useTranslation();
  const hasPendingAck = point.pending_ack_alarm_ids.length > 0;
  const meters: [number, number] | null =
    point.x_m != null && point.y_m != null ? [point.x_m, point.y_m] : null;

  return (
    <div {...repeatedTestId('computed-suspicion-row', point.id)}>
      <div className="computed-suspicion-row-line">
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
              {point.sensor_ids.length === 1
                ? sensorLabel(point.sensor_ids[0])
                : t('suspicion_computed_point', {
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
            {point.x == null && ` · ${t('suspicion_unplaced')}`}
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
      {onShowMoment && point.first_seen && (
        <EventJumpButton
          at={point.first_seen}
          onShow={(at) => onShowMoment(at, point.lageplan)}
          testKey={point.id}
        />
      )}
      </div>

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
              <span
                key={sensorId}
                className="computed-suspicion-sensor"
                // Points the sensor out on the plan while hovered (or focused).
                tabIndex={onSensorHover ? 0 : undefined}
                onMouseEnter={() => onSensorHover?.(sensorId)}
                onMouseLeave={() => onSensorHover?.(null)}
                onFocus={() => onSensorHover?.(sensorId)}
                onBlur={() => onSensorHover?.(null)}
                {...repeatedTestId('computed-suspicion-sensor', sensorId)}
              >
                {sensorLabel(sensorId)}
              </span>
            ))}
          </div>
          <div className="verdachtsstellen-details-title">
            {t('status_alarm_history')}
          </div>
          <AlarmHistoryTable
            entries={point.alarms ?? []}
            sensorLabel={point.sensor_ids.length > 1 ? sensorLabel : undefined}
            testId={`computed-suspicion-history-${point.id}`}
            rowTestId="computed-suspicion-history-row"
          />
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

/** "Jump to Event" in a point's row: the plan's frame picker to its
 * detection - the frame its ring shows on (suspicionsAtFrame) - on its
 * plan. */
const EventJumpButton = ({
  at,
  onShow,
  testKey,
}: {
  at: string;
  onShow: (at: string) => void;
  testKey: string;
}) => {
  const { t } = useTranslation();
  const hint = t('suspicion_jump_to_event_hint', { date: formatDate(at) });
  return (
    <button
      type="button"
      className="verdachtsstellen-jump computed-suspicion-jump"
      title={hint}
      aria-label={hint}
      onClick={() => onShow(at)}
      {...repeatedTestId('computed-suspicion-jump', testKey)}
    >
      <SkipBackwardFill size={12} />
      <span className="computed-suspicion-jump-label">
        {t('suspicion_jump_to_event')}
      </span>
    </button>
  );
};

/** "Erstes Auftreten anzeigen": the plan's time slider to the first detection
 * (also in VerdachtsstellenPanel). */
export const FirstDetectionButton = ({
  at,
  onShow,
  testId,
  testKey,
}: {
  at: string;
  onShow: (at: string) => void;
  testId: string;
  testKey: string;
}) => {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className="verdachtsstellen-jump"
      title={t('suspicion_show_first_seen_hint', { date: formatDate(at) })}
      onClick={() => onShow(at)}
      {...repeatedTestId(testId, testKey)}
    >
      <ClockHistory size={14} />
      <span>{t('suspicion_show_first_seen')}</span>
    </button>
  );
};

export default ComputedSuspicionPanel;
