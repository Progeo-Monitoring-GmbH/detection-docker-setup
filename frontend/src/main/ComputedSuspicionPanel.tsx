import { useRef, useState, type ReactNode } from 'react';
import { Offcanvas, Spinner } from 'react-bootstrap';
import {
  CheckLg,
  ChevronLeft,
  ChevronRight,
  ClockHistory,
  InfoCircle,
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
import useElementWidth from '../components/ui/useElementWidth';
import {
  pointLetter,
  sensorList,
  type ComputedSuspicionPoint,
  type SuspicionMode,
} from './computedSuspicion';
import { formatDate } from './dateFormat';
import AlarmHistoryTable from './AlarmHistoryTable';
import { repeatedTestId } from '../testIds';
import './VerdachtsstellenPanel.css';
import './ComputedSuspicionPanel.css';

/** From this panel width (px) the points are tiles and their details a sheet
 * from below - the side column wrapped under the plan (a tablet held upright).
 * Narrower (the column beside the plan, phones): a list whose details replace it. */
export const TILE_MIN_WIDTH = 560;

/** Below this panel width (px) the alarm history keeps date and value in the
 * row and folds the rest under it - four columns would scroll sideways. */
const COMPACT_TABLE_WIDTH = 460;

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
  /** A member sensor hovered or tapped (null: none) - the plan points it out. */
  onSensorHover?: (sensorId: number | null) => void;
  /** Sets the plan's time slider to a moment (ISO-8601) - the detection
   * ("Jump to Event") - and the plan to the point's. */
  onShowMoment?: (at: string, plan?: number | null) => void;
};

/** "Bereich um 3 Sensoren", or the sensor of a single-sensor point. */
const usePointLabel = (sensorLabel: (sensorId: number) => string) => {
  const { t } = useTranslation();
  return (point: ComputedSuspicionPoint) =>
    point.sensor_ids.length === 1
      ? sensorLabel(point.sensor_ids[0])
      : t('suspicion_computed_point', { count: point.sensor_ids.length });
};

const peakValue = (point: ComputedSuspicionPoint) =>
  point.max_value != null ? String(Math.round(point.max_value)) : '–';

/** The point's letter - the same as its ring on the plan. */
const PointLetter = ({ point, letter }: { point: ComputedSuspicionPoint; letter: string }) => (
  <span
    className={`computed-suspicion-letter computed-suspicion-letter--${point.state}`}
  >
    {letter}
  </span>
);

/**
 * The computed suspicion points of the selected range (every product) -
 * the places a leak most likely is, aggregated from the sensors over their
 * threshold (computedSuspicion.ts). Each point is lettered like its ring on
 * the plan. Tapping one opens its details (sensors, alarm history, "Jump to
 * Event", acknowledgement): in a narrow panel they replace the list (with a
 * way back), in a wide one (TILE_MIN_WIDTH) the points are tiles and the
 * details a sheet from below, the plan staying in view above it.
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
  const bodyRef = useRef<HTMLDivElement>(null);
  // 0 until measured (and in tests): the narrow list with the full table.
  const width = useElementWidth(bodyRef, 0);
  const wide = width >= TILE_MIN_WIDTH;
  const compactTable = width > 0 && width < COMPACT_TABLE_WIDTH;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hintOpen, setHintOpen] = useState(false);
  // The sensor tapped in the details - it stays marked on the plan.
  const [pinnedSensor, setPinnedSensor] = useState<number | null>(null);
  // The point whose pending alarms wait for the confirmation to be acknowledged.
  const [ackTarget, setAckTarget] = useState<{
    point: ComputedSuspicionPoint;
    letter: string;
  } | null>(null);

  const selectedIndex = points.findIndex((point) => point.id === selectedId);
  const selected = selectedIndex >= 0 ? points[selectedIndex] : null;

  const select = (id: string | null) => {
    if (pinnedSensor != null) {
      setPinnedSensor(null);
      onSensorHover?.(null);
    }
    setSelectedId(id);
  };

  const details = selected && (
    <ComputedSuspicionDetails
      point={selected}
      letter={pointLetter(selectedIndex)}
      onBack={wide ? undefined : () => select(null)}
      compactTable={compactTable}
      onAcknowledge={() =>
        setAckTarget({ point: selected, letter: pointLetter(selectedIndex) })
      }
      acknowledging={acknowledging.has(selected.id)}
      readOnly={readOnly}
      sensorLabel={sensorLabel}
      pinnedSensor={pinnedSensor}
      onSensorHover={
        onSensorHover &&
        ((sensorId) => onSensorHover(sensorId ?? pinnedSensor))
      }
      onSensorPin={
        onSensorHover &&
        ((sensorId) => {
          const next = pinnedSensor === sensorId ? null : sensorId;
          setPinnedSensor(next);
          onSensorHover(next);
        })
      }
      onShowMoment={
        onShowMoment &&
        ((at, plan) => {
          onShowMoment(at, plan);
          // The sheet covers the plan - close it to show the moment there.
          if (wide) {
            select(null);
          }
        })
      }
    />
  );

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
    if (selected && !wide) {
      return details;
    }
    return (
      <div
        className={wide ? 'computed-suspicion-tiles' : 'computed-suspicion-list'}
        data-testid="computed-suspicion-list"
      >
        {points.map((point, index) => (
          <ComputedSuspicionItem
            key={point.id}
            point={point}
            letter={pointLetter(index)}
            tile={wide}
            selected={point.id === selectedId}
            sensorLabel={sensorLabel}
            onSelect={() => select(point.id === selectedId ? null : point.id)}
          />
        ))}
      </div>
    );
  };

  return (
    <PanelCard
      testId="computed-suspicion"
      title={
        <span className="computed-suspicion-title">
          {t('suspicion_computed_title')}
          <button
            type="button"
            className="computed-suspicion-hint-toggle"
            title={t('suspicion_computed_hint_toggle')}
            aria-label={t('suspicion_computed_hint_toggle')}
            aria-expanded={hintOpen}
            onClick={() => setHintOpen((open) => !open)}
            data-testid="computed-suspicion-hint-toggle"
          >
            <InfoCircle size={15} />
          </button>
        </span>
      }
      actions={headerActions}
    >
      <div ref={bodyRef}>
        {hintOpen && (
          <div
            className="computed-suspicion-hint"
            data-testid="computed-suspicion-hint"
          >
            {t('suspicion_computed_hint')}
          </div>
        )}
        {body()}
      </div>
      {/* Tablets held upright: the details as a sheet below the plan. */}
      <Offcanvas
        show={wide && selected !== null}
        onHide={() => select(null)}
        placement="bottom"
        className="computed-suspicion-sheet"
        data-testid="computed-suspicion-sheet"
      >
        <Offcanvas.Header
          closeButton
          closeLabel={t('suspicion_sheet_close')}
          className="computed-suspicion-sheet-head"
        />
        <Offcanvas.Body className="computed-suspicion-sheet-body">
          {wide && details}
        </Offcanvas.Body>
      </Offcanvas>
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

type ComputedSuspicionItemProps = {
  point: ComputedSuspicionPoint;
  letter: string;
  /** A tile (wide panel) instead of a list row. */
  tile: boolean;
  selected: boolean;
  sensorLabel: (sensorId: number) => string;
  onSelect: () => void;
};

/** A point in the list (a row) or the grid (a tile) - tapping opens its details. */
const ComputedSuspicionItem = ({
  point,
  letter,
  tile,
  selected,
  sensorLabel,
  onSelect,
}: ComputedSuspicionItemProps) => {
  const { t } = useTranslation();
  const label = usePointLabel(sensorLabel)(point);
  const summary = [
    point.severity && t(`ui_severity_${point.severity}`),
    point.last_seen && formatDate(point.last_seen, 'date'),
  ]
    .filter(Boolean)
    .join(' · ');
  const peak = (
    <span
      className="computed-suspicion-peak"
      {...repeatedTestId('computed-suspicion-peak', point.id)}
    >
      {peakValue(point)}
      <small> mV</small>
    </span>
  );

  return (
    <div {...repeatedTestId('computed-suspicion-row', point.id)}>
      <button
        type="button"
        onClick={onSelect}
        aria-expanded={selected}
        className={`${tile ? 'computed-suspicion-tile' : 'computed-suspicion-item'}${selected ? ' is-selected' : ''}`}
        {...repeatedTestId('computed-suspicion-toggle', point.id)}
      >
        {tile ? (
          <>
            <span className="computed-suspicion-tile-top">
              <PointLetter point={point} letter={letter} />
              <StateBadge state={point.state} label={t(`ui_${point.state}`)} />
            </span>
            {peak}
            <span className="computed-suspicion-label">{label}</span>
            <span className="computed-suspicion-meta">{summary}</span>
          </>
        ) : (
          <>
            <PointLetter point={point} letter={letter} />
            <span className="computed-suspicion-item-main">
              <span className="computed-suspicion-label">{label}</span>
              <span className="computed-suspicion-meta">
                <span
                  className={`computed-suspicion-dot computed-suspicion-dot--${point.state}`}
                />
                {[t(`ui_${point.state}`), summary].filter(Boolean).join(' · ')}
              </span>
            </span>
            {peak}
            <ChevronRight className="computed-suspicion-chevron" />
          </>
        )}
      </button>
    </div>
  );
};

type ComputedSuspicionDetailsProps = {
  point: ComputedSuspicionPoint;
  letter: string;
  /** Narrow panel: back to the list (the details replace it). */
  onBack?: () => void;
  /** The alarm history's phone layout (a narrow panel). */
  compactTable: boolean;
  onAcknowledge: () => void;
  acknowledging: boolean;
  readOnly: boolean;
  sensorLabel: (sensorId: number) => string;
  pinnedSensor: number | null;
  /** Hovered (or left: null) - mouse and keyboard. */
  onSensorHover?: (sensorId: number | null) => void;
  /** Tapped - marks the sensor on the plan until the next tap. */
  onSensorPin?: (sensorId: number) => void;
  onShowMoment?: (at: string, plan?: number | null) => void;
};

/** A point's details: header, actions, key figures, sensors, alarm history. */
const ComputedSuspicionDetails = ({
  point,
  letter,
  onBack,
  compactTable,
  onAcknowledge,
  acknowledging,
  readOnly,
  sensorLabel,
  pinnedSensor,
  onSensorHover,
  onSensorPin,
  onShowMoment,
}: ComputedSuspicionDetailsProps) => {
  const { t, i18n } = useTranslation();
  const label = usePointLabel(sensorLabel)(point);
  const hasPendingAck = point.pending_ack_alarm_ids.length > 0;
  const meters: [number, number] | null =
    point.x_m != null && point.y_m != null ? [point.x_m, point.y_m] : null;
  const meta = [
    sensorList(point.sensor_ids, sensorLabel),
    point.last_seen &&
      t('suspicion_last_seen', { date: formatDate(point.last_seen, 'date') }),
    meters && formatMeters(meters),
    point.x == null && t('suspicion_unplaced'),
  ]
    .filter(Boolean)
    .join(' · ');
  const facts: [string, string][] = [
    [t('suspicion_fact_strength'), `${Math.round(point.strength * 100)} %`],
    ...(point.max_exceedance != null
      ? [
          [
            t('suspicion_fact_exceedance'),
            t('suspicion_fact_exceedance_value', {
              // 47,0 in German, 47.0 in English.
              value: point.max_exceedance.toLocaleString(i18n.language, {
                minimumFractionDigits: 1,
                maximumFractionDigits: 1,
              }),
            }),
          ] as [string, string],
        ]
      : []),
    ...(point.first_seen
      ? [[t('suspicion_fact_first_seen'), formatDate(point.first_seen)] as [string, string]]
      : []),
    [t('suspicion_fact_readings'), String(point.readings)],
  ];

  return (
    <div
      className="computed-suspicion-details"
      {...repeatedTestId('computed-suspicion-details', point.id)}
    >
      {onBack && (
        <button
          type="button"
          className="computed-suspicion-back"
          onClick={onBack}
          data-testid="computed-suspicion-back"
        >
          <ChevronLeft />
          {t('suspicion_back_to_list')}
        </button>
      )}
      <div className="computed-suspicion-details-head">
        <PointLetter point={point} letter={letter} />
        <span className="computed-suspicion-details-title">
          <span className="computed-suspicion-label">{label}</span>
          <span className="computed-suspicion-badges">
            <StateBadge state={point.state} label={t(`ui_${point.state}`)} />
            {point.severity && (
              <SeverityBadge
                severity={point.severity}
                label={t(`ui_severity_${point.severity}`)}
              />
            )}
          </span>
        </span>
        <span className="computed-suspicion-details-peak">
          <b>{peakValue(point)}</b>
          <small>{t('suspicion_peak_unit')}</small>
        </span>
      </div>
      <div className="computed-suspicion-meta">{meta}</div>

      <div className="computed-suspicion-actions">
        {onShowMoment && point.first_seen && (
          <EventJumpButton
            at={point.first_seen}
            onShow={(at) => onShowMoment(at, point.lageplan)}
            testKey={point.id}
          />
        )}
        <button
          type="button"
          hidden={readOnly}
          onClick={onAcknowledge}
          {...repeatedTestId('computed-suspicion-acknowledge', point.id)}
          disabled={!hasPendingAck || acknowledging}
          className={`verdachtsstellen-ack computed-suspicion-ack${hasPendingAck ? ' verdachtsstellen-ack--pending' : ''}`}
        >
          {acknowledging ? (
            <Spinner size="sm" animation="border" />
          ) : (
            <CheckLg size={15} />
          )}
          <span>
            {t('ui_quittieren')}
            {hasPendingAck && ` (${point.pending_ack_alarm_ids.length})`}
          </span>
        </button>
      </div>

      <div className="computed-suspicion-caption">{t('suspicion_facts')}</div>
      <div className="computed-suspicion-facts">
        {facts.map(([name, value]) => (
          <div key={name} className="computed-suspicion-fact">
            <span>{name}</span>
            <b>{value}</b>
          </div>
        ))}
      </div>

      <div className="computed-suspicion-caption">
        {t('suspicion_member_sensors')}
      </div>
      <div className="computed-suspicion-sensors">
        {point.sensor_ids.map((sensorId) => (
          <button
            type="button"
            key={sensorId}
            className={`computed-suspicion-sensor${pinnedSensor === sensorId ? ' is-pinned' : ''}`}
            aria-pressed={pinnedSensor === sensorId}
            // Points the sensor out on the plan while hovered (or focused);
            // a tap keeps it marked.
            onMouseEnter={() => onSensorHover?.(sensorId)}
            onMouseLeave={() => onSensorHover?.(null)}
            onFocus={() => onSensorHover?.(sensorId)}
            onBlur={() => onSensorHover?.(null)}
            onClick={() => onSensorPin?.(sensorId)}
            {...repeatedTestId('computed-suspicion-sensor', sensorId)}
          >
            {sensorLabel(sensorId)}
          </button>
        ))}
      </div>
      {onSensorPin && (
        <div className="computed-suspicion-note">
          {pinnedSensor != null && point.sensor_ids.includes(pinnedSensor)
            ? t('suspicion_sensor_pinned', { sensor: sensorLabel(pinnedSensor) })
            : t('suspicion_sensor_pin_hint')}
        </div>
      )}

      <div className="computed-suspicion-caption">
        {t('status_alarm_history')}
      </div>
      <AlarmHistoryTable
        entries={point.alarms ?? []}
        sensorLabel={point.sensor_ids.length > 1 ? sensorLabel : undefined}
        testId={`computed-suspicion-history-${point.id}`}
        rowTestId="computed-suspicion-history-row"
        compact={compactTable}
      />
    </div>
  );
};

/** "Ereignis" in a point's details: the plan's frame picker to its
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
      <span>{t('suspicion_jump_to_event')}</span>
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
