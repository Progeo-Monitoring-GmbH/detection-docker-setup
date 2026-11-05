import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Spinner } from 'react-bootstrap';
import { ArrowCounterclockwise, XLg } from 'react-bootstrap-icons';
import { useSnackbar } from 'notistack';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig';
import { showRequestError, showSuccessBar } from '../components/ui/Snackbar.jsx';
import PanelCard from '../components/ui/kit/PanelCard';
import PillButton from '../components/ui/kit/PillButton';
import SegmentedControl from '../components/ui/kit/SegmentedControl';
import { useWheelHint, useZoomWheel, WheelZoomHint } from '../components/ui/wheelZoom';
import {
  effectiveThresholdOf,
  isOver,
  labelEveryOf,
  type MixerSensor,
  NO_DRAFTS,
  objectThresholdOf,
  overrideOf,
  rangeBetween,
  savePayloadOf,
  snapped,
  snapStepOf,
  type ThresholdChange,
  type ThresholdDrafts,
  thresholdChanges,
  withOverrides,
  withoutChange,
} from './thresholdMixer';

const PERIODS = [1, 7, 30, 90, 365];
const DEFAULT_PERIOD = 30;

const MUTED = '#8B8383';
const BAR = '#A9BCCF';
const BAR_OVER = '#C44D26';
const OBJECT_LINE = 'var(--progeo-orange)';
const OWN = '#2a78d6';
const SELECTED_BG = 'rgba(42, 120, 214, .10)';

// Geometry (px): the plot area, the y-axis gutter left of the scroller.
const PLOT_TOP = 10;
const PLOT_H = 230;
const AXIS_H = 26;
const SVG_H = PLOT_TOP + PLOT_H + AXIS_H;
const GUTTER = 58;
/** Column width: at least this (then the plot scrolls), at most MAX_COLUMN. */
const MIN_COLUMN = 14;
const MAX_COLUMN = 64;
/** Zoomed all the way out a column may get this narrow (all sensors visible). */
const MIN_ZOOM_COLUMN = 3;
/** How close (px) to a handle or the object line a press grabs it. */
const GRAB_PX = 7;

type Drag = { kind: 'object' } | { kind: 'sensors'; orders: number[] };

const formatValue = (value: number | null) => (value == null ? '–' : String(Math.round(value * 10) / 10));

/**
 * Schwellwerte as a mixing desk: per sensor a bar of its highest alarm value
 * |WP - EP| in the period, the object's threshold as an orange line (drag
 * its grip in the axis, or type it) and every individual threshold as a blue
 * handle to drag up and down. A click selects a sensor (Shift: a range,
 * Ctrl/⌘: add); dragging a selected one moves them all, and the selection
 * can be set to a value or lose its individual thresholds at once. Built for
 * 4 as for 500 sensors: columns keep a minimum width and scroll, Ctrl/⌘ +
 * wheel zooms them. Edits stay drafts - the panel next to "Speichern" lists
 * them, each undoable - and only real changes are saved.
 */
const ThresholdMixerPanel = ({
  locationId,
  initialObjectThreshold,
  canEdit,
}: {
  locationId: number | string;
  initialObjectThreshold: number | null;
  canEdit: boolean;
}) => {
  const auth = useAuth();
  const { t } = useTranslation();
  const { enqueueSnackbar } = useSnackbar();

  const [days, setDays] = useState(DEFAULT_PERIOD);
  const [sensors, setSensors] = useState<MixerSensor[]>([]);
  const [loading, setLoading] = useState(true);
  const [savedObject, setSavedObject] = useState<number | null>(initialObjectThreshold);
  const [drafts, setDrafts] = useState<ThresholdDrafts>(NO_DRAFTS);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  const [bulkValue, setBulkValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [hovered, setHovered] = useState<number | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  // The y-scale stays put while dragging - it would jump under the pointer.
  const [frozenScale, setFrozenScale] = useState<number | null>(null);
  const [zoomColumn, setZoomColumn] = useState<number | null>(null);
  const [width, setWidth] = useState(800);
  const [wheelHint, showWheelHint] = useWheelHint();
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const requestRef = useRef(0);

  const load = useCallback(
    (period: number) => {
      // Loading starts where the period or the data change (initially true).
      const request = ++requestRef.current;
      void axiosConfig.perform_get(
        auth,
        `/v1/location/${locationId}/measurepoints/?days=${period}`,
        (response) => {
          if (request !== requestRef.current) {
            return;
          }
          setSensors(((response?.data?.sensors || []) as MixerSensor[]).map((sensor) => ({
            ...sensor,
            max: sensor.max ?? null,
          })));
          setLoading(false);
        },
        (error) => {
          if (request === requestRef.current) {
            showRequestError(enqueueSnackbar, t('einstell_mixer_load_failed'), error);
            setLoading(false);
          }
        },
      );
    },
    [auth, enqueueSnackbar, locationId, t],
  );

  useEffect(() => {
    load(days);
  }, [load, days]);

  // The scroller's width decides the column width.
  useLayoutEffect(() => {
    const element = scrollerRef.current;
    if (!element || typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    const observer = new ResizeObserver(() => setWidth(element.clientWidth || 800));
    observer.observe(element);
    return () => observer.disconnect();
  }, [loading]);

  const orders = useMemo(() => sensors.map((sensor) => sensor.sensor_order), [sensors]);
  const count = Math.max(sensors.length, 1);
  const fitColumn = Math.max(MIN_ZOOM_COLUMN, width / count);
  const defaultColumn = Math.min(MAX_COLUMN, Math.max(MIN_COLUMN, fitColumn));
  const column = zoomColumn != null ? Math.min(MAX_COLUMN, Math.max(Math.min(fitColumn, MIN_COLUMN), zoomColumn)) : defaultColumn;
  const plotWidth = Math.max(width, column * sensors.length);

  useZoomWheel(
    scrollerRef,
    (event) => {
      const factor = event.deltaY < 0 ? 1.25 : 0.8;
      setZoomColumn((current) => (current ?? column) * factor);
    },
    showWheelHint,
    [loading],
  );

  const objectThreshold = objectThresholdOf(savedObject, drafts);
  const changes = useMemo(() => thresholdChanges(sensors, savedObject, drafts), [sensors, savedObject, drafts]);

  const liveScale = useMemo(() => {
    const values = sensors.flatMap((sensor) => [sensor.max, effectiveThresholdOf(sensor, savedObject, drafts)]);
    return Math.max(1, ...values.filter((value): value is number => value != null)) * 1.15;
  }, [sensors, savedObject, drafts]);
  const scale = frozenScale ?? liveScale;
  const step = snapStepOf(scale);
  const toY = (value: number) => PLOT_TOP + PLOT_H - (Math.min(value, scale) / scale) * PLOT_H;
  const valueAt = (y: number) => snapped(((PLOT_TOP + PLOT_H - y) / PLOT_H) * scale, step);

  const labelOf = (order: number) =>
    sensors.find((sensor) => sensor.sensor_order === order)?.name || t('einstell_points_sensor', { sensor: order });
  const overCount = sensors.filter((sensor) => isOver(sensor, savedObject, drafts)).length;
  const ownCount = sensors.filter((sensor) => overrideOf(sensor, drafts) != null).length;

  // -- pointer: grab a handle / the object line, else select -----------------

  const pointerAt = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const index = Math.floor(x / column);
    return { index, y: event.clientY - rect.top, sensor: sensors[index] ?? null };
  };

  const grabAt = (sensor: MixerSensor | null, y: number): Drag | null => {
    if (!canEdit) {
      return null;
    }
    if (sensor) {
      const own = overrideOf(sensor, drafts);
      const isSelected = selected.has(sensor.sensor_order);
      const effective = effectiveThresholdOf(sensor, savedObject, drafts);
      // Its own handle - or, while selected, its spot on the object line.
      if ((own != null || isSelected) && effective != null && Math.abs(y - toY(effective)) <= GRAB_PX) {
        return { kind: 'sensors', orders: isSelected ? [...selected] : [sensor.sensor_order] };
      }
    }
    if (objectThreshold != null && Math.abs(y - toY(objectThreshold)) <= GRAB_PX) {
      return { kind: 'object' };
    }
    return null;
  };

  const applyDrag = (current: Drag, value: number) => {
    if (current.kind === 'object') {
      setDrafts((prev) => ({ ...prev, object: value }));
    } else {
      setDrafts((prev) => withOverrides(prev, current.orders, value));
    }
  };

  const startDrag = (next: Drag, target: Element, pointerId: number) => {
    setDrag(next);
    setFrozenScale(liveScale);
    try {
      target.setPointerCapture(pointerId);
    } catch {
      // jsdom / old browsers: the drag still works while over the plot.
    }
  };

  const onPointerDown = (event: PointerEvent<SVGSVGElement>) => {
    const { sensor, y } = pointerAt(event);
    const next = grabAt(sensor, y);
    if (next) {
      event.preventDefault();
      startDrag(next, event.currentTarget, event.pointerId);
      return;
    }
    if (!sensor || !canEdit) {
      return;
    }
    // A click selects: alone, with Ctrl/⌘ added/removed, with Shift a range.
    const order = sensor.sensor_order;
    if (event.shiftKey && anchor != null) {
      setSelected((prev) => new Set([...prev, ...rangeBetween(orders, anchor, order)]));
    } else if (event.ctrlKey || event.metaKey) {
      setSelected((prev) => {
        const next = new Set(prev);
        if (!next.delete(order)) {
          next.add(order);
        }
        return next;
      });
      setAnchor(order);
    } else {
      setSelected((prev) => (prev.size === 1 && prev.has(order) ? new Set() : new Set([order])));
      setAnchor(order);
    }
  };

  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const { sensor, y } = pointerAt(event);
    if (drag) {
      applyDrag(drag, valueAt(y));
      return;
    }
    setHovered(sensor?.sensor_order ?? null);
    event.currentTarget.style.cursor = grabAt(sensor, y) ? 'ns-resize' : canEdit && sensor ? 'pointer' : 'default';
  };

  const endDrag = () => {
    setDrag(null);
    setFrozenScale(null);
  };

  // The object grip in the axis gutter: drag (or arrow keys) moves the line.
  const onGripDown = (event: PointerEvent<SVGElement>) => {
    if (!canEdit) {
      return;
    }
    event.preventDefault();
    startDrag({ kind: 'object' }, event.currentTarget, event.pointerId);
  };
  const onGripMove = (event: PointerEvent<SVGElement>) => {
    if (drag?.kind !== 'object') {
      return;
    }
    const rect = (event.currentTarget.ownerSVGElement ?? event.currentTarget).getBoundingClientRect();
    applyDrag(drag, valueAt(event.clientY - rect.top));
  };

  const nudge = (event: KeyboardEvent, current: number | null, set: (value: number | null) => void) => {
    const by = (event.shiftKey ? 10 : 1) * step;
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      set(snapped((current ?? 0) + (event.key === 'ArrowUp' ? by : -by), step));
    }
  };

  // -- selection tools ---------------------------------------------------------

  const selectedOrders = orders.filter((order) => selected.has(order));
  const bulkNumber = bulkValue.trim() === '' ? null : Number(bulkValue);
  const bulkValid = bulkNumber != null && Number.isFinite(bulkNumber) && bulkNumber >= 0;

  // -- save ----------------------------------------------------------------------

  const save = async () => {
    const payload = savePayloadOf(changes);
    setSaving(true);
    const request = (send: (done: () => void, failed: (error: unknown) => void) => void) =>
      new Promise<void>((resolve, reject) => send(resolve, reject));
    let objectSaved = false;
    try {
      if (payload.object) {
        const object = payload.object;
        await request((done, failed) =>
          axiosConfig.perform_patch(auth, `/v1/location/${locationId}/`, object, done, failed),
        );
        objectSaved = true;
        setSavedObject(object.alarm_threshold);
      }
      if (payload.points.length) {
        await request((done, failed) =>
          axiosConfig.perform_post(
            auth,
            `/v1/location/${locationId}/measurepoints/`,
            { points: payload.points },
            done,
            failed,
          ),
        );
      }
      showSuccessBar(enqueueSnackbar, t('einstell_mixer_saved', { count: changes.length }));
      setDrafts(NO_DRAFTS);
      setLoading(true);
      load(days);
    } catch (error) {
      showRequestError(enqueueSnackbar, t('einstell_mixer_save_failed'), error as never);
      // A saved object threshold is no draft any more.
      if (objectSaved) {
        setDrafts((prev) => withoutChange(prev, { key: 'object', kind: 'object', from: null, to: null }));
      }
    } finally {
      setSaving(false);
    }
  };

  const changeText = (change: ThresholdChange) => {
    const shown = (value: number | null) =>
      value == null
        ? change.kind === 'object'
          ? t('einstell_mixer_none')
          : t('einstell_mixer_inherits', { value: formatValue(objectThreshold) })
        : `${formatValue(value)} mV`;
    return `${shown(change.from)} → ${shown(change.to)}`;
  };

  // -- render ----------------------------------------------------------------------

  const every = labelEveryOf(column);
  const hoveredSensor = sensors.find((sensor) => sensor.sensor_order === hovered) ?? null;
  const yTicks = [0, scale / 1.15 / 2, scale / 1.15].map((value) => Math.round(value));

  const chart = (
    <div style={{ display: 'flex', position: 'relative' }}>
      {/* The y-axis with the object grip stays put while the columns scroll. */}
      <svg width={GUTTER} height={SVG_H} style={{ flexShrink: 0, overflow: 'visible' }} aria-hidden={!canEdit}>
        {yTicks.map((tick) => (
          <text key={tick} x={GUTTER - 8} y={toY(tick) + 3} textAnchor="end" fontSize={10} fill={MUTED}>
            {tick}
          </text>
        ))}
        {objectThreshold != null && (
          <g
            role="slider"
            tabIndex={canEdit ? 0 : -1}
            aria-label={t('einstell_alarm_threshold')}
            aria-valuenow={objectThreshold}
            aria-valuemin={0}
            aria-valuemax={Math.round(scale)}
            style={{ cursor: canEdit ? 'ns-resize' : 'default', outline: 'none' }}
            onPointerDown={onGripDown}
            onPointerMove={onGripMove}
            onPointerUp={endDrag}
            onKeyDown={(event) =>
              canEdit && nudge(event, objectThreshold, (value) => setDrafts((prev) => ({ ...prev, object: value })))
            }
          >
            <rect x={2} y={toY(objectThreshold) - 9} width={GUTTER - 6} height={18} rx={9} fill={OBJECT_LINE} />
            <text x={GUTTER / 2 - 1} y={toY(objectThreshold) + 4} textAnchor="middle" fontSize={10.5} fontWeight={600} fill="#fff">
              {formatValue(objectThreshold)}
            </text>
          </g>
        )}
      </svg>

      <div ref={scrollerRef} style={{ overflowX: 'auto', overflowY: 'hidden', flex: 1, minWidth: 0, position: 'relative' }}>
        <svg
          width={plotWidth}
          height={SVG_H}
          style={{ display: 'block', touchAction: 'none', userSelect: 'none' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onPointerLeave={() => !drag && setHovered(null)}
          data-testid="threshold-mixer-plot"
        >
          <line x1={0} x2={plotWidth} y1={PLOT_TOP + PLOT_H} y2={PLOT_TOP + PLOT_H} stroke="var(--progeo-track)" />
          {sensors.map((sensor, index) => {
            const x = index * column;
            const order = sensor.sensor_order;
            const own = overrideOf(sensor, drafts);
            const effective = effectiveThresholdOf(sensor, savedObject, drafts);
            const isSelected = selected.has(order);
            const barWidth = Math.max(1, column * 0.62);
            return (
              <g key={order} data-sensor={order}>
                {(isSelected || hovered === order) && (
                  <rect
                    x={x}
                    y={PLOT_TOP}
                    width={column}
                    height={PLOT_H}
                    fill={isSelected ? SELECTED_BG : 'rgba(11, 54, 89, .04)'}
                  />
                )}
                {sensor.max != null && (
                  <rect
                    x={x + (column - barWidth) / 2}
                    y={toY(sensor.max)}
                    width={barWidth}
                    height={Math.max(1, PLOT_TOP + PLOT_H - toY(sensor.max))}
                    rx={Math.min(3, barWidth / 3)}
                    fill={isOver(sensor, savedObject, drafts) ? BAR_OVER : BAR}
                  />
                )}
                {effective != null && (own != null || isSelected) && (
                  <rect
                    data-handle={order}
                    x={x + column * 0.05}
                    y={toY(effective) - 2}
                    width={column * 0.9}
                    height={4}
                    rx={2}
                    fill={own != null ? OWN : '#fff'}
                    stroke={OWN}
                    strokeWidth={own != null ? 0 : 1.5}
                  />
                )}
                {index % every === 0 && (
                  <text x={x + column / 2} y={SVG_H - 8} textAnchor="middle" fontSize={10} fill={MUTED}>
                    {order}
                  </text>
                )}
              </g>
            );
          })}
          {/* Over the columns, so it reads as one line across the desk. */}
          {objectThreshold != null && (
            <line
              x1={0}
              x2={plotWidth}
              y1={toY(objectThreshold)}
              y2={toY(objectThreshold)}
              stroke={OBJECT_LINE}
              strokeWidth={2}
              pointerEvents="none"
            />
          )}
        </svg>
        <WheelZoomHint visible={wheelHint} radius={0} />
      </div>

      {hoveredSensor && !drag && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            right: 0,
            background: '#07223A',
            color: '#fff',
            borderRadius: 8,
            padding: '6px 10px',
            fontSize: 11.5,
            lineHeight: 1.5,
            pointerEvents: 'none',
            boxShadow: '0 6px 18px rgba(11, 54, 89, .3)',
          }}
        >
          <div style={{ fontWeight: 600 }}>{labelOf(hoveredSensor.sensor_order)}</div>
          <div>
            {t('einstell_mixer_max')}: {formatValue(hoveredSensor.max)} mV
          </div>
          <div>
            {t('einstell_points_threshold')}: {formatValue(effectiveThresholdOf(hoveredSensor, savedObject, drafts))} mV
            <span style={{ opacity: 0.7 }}>
              {' '}
              ({overrideOf(hoveredSensor, drafts) != null ? t('einstell_mixer_own') : t('einstell_mixer_object')})
            </span>
          </div>
        </div>
      )}
    </div>
  );

  const legendItem = (swatch: ReactNode, label: string) => (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      {swatch}
      {label}
    </span>
  );

  return (
    <PanelCard
      title={t('einstell_section_thresholds')}
      actions={
        <SegmentedControl
          options={PERIODS.map((period) => ({
            value: String(period),
            label: period === 1 ? t('einstell_mixer_24h') : t('einstell_mixer_days', { count: period }),
          }))}
          value={String(days)}
          onChange={(value) => {
            setLoading(true);
            setDays(Number(value));
          }}
        />
      }
    >
      <div className="d-flex flex-column gap-3">
        <div className="d-flex align-items-center gap-3 flex-wrap">
          <div style={{ flex: '1 1 260px' }}>
            <div style={{ fontSize: 13.5, fontWeight: 500 }}>{t('einstell_alarm_threshold')}</div>
            <div style={{ fontSize: 12, color: MUTED }}>{t('einstell_mixer_hint')}</div>
          </div>
          <label className="d-flex align-items-center gap-2 mb-0">
            <input
              type="number"
              min={0}
              step={step}
              aria-label={t('einstell_alarm_threshold')}
              value={objectThreshold ?? ''}
              readOnly={!canEdit}
              onChange={(event) =>
                setDrafts((prev) => ({
                  ...prev,
                  object: event.target.value === '' ? null : Number(event.target.value),
                }))
              }
              style={{
                height: 36,
                width: 110,
                border: 'none',
                borderRadius: 10,
                background: 'var(--progeo-track-soft)',
                padding: '0 12px',
                fontFamily: 'inherit',
                fontSize: 14,
                color: 'var(--progeo-blue)',
              }}
            />
            <span style={{ fontSize: 13, color: MUTED }}>mV</span>
          </label>
        </div>

        <div className="d-flex align-items-center gap-3 flex-wrap" style={{ fontSize: 12, color: '#6E6868' }}>
          {legendItem(<span style={{ width: 10, height: 12, borderRadius: 2, background: BAR }} />, t('einstell_mixer_max_legend'))}
          {legendItem(<span style={{ width: 10, height: 12, borderRadius: 2, background: BAR_OVER }} />, t('einstell_mixer_over_legend', { count: overCount }))}
          {legendItem(<span style={{ width: 16, height: 3, background: OBJECT_LINE }} />, t('einstell_mixer_object'))}
          {legendItem(<span style={{ width: 16, height: 4, borderRadius: 2, background: OWN }} />, t('einstell_mixer_own_legend', { count: ownCount }))}
          <span style={{ marginLeft: 'auto', color: MUTED }}>{canEdit ? t('einstell_mixer_usage') : null}</span>
        </div>

        {loading && sensors.length === 0 ? (
          <div className="d-flex justify-content-center py-5 text-muted">
            <Spinner animation="border" size="sm" />
          </div>
        ) : sensors.length === 0 ? (
          <div style={{ fontSize: 13, color: MUTED }}>{t('einstell_points_empty')}</div>
        ) : (
          <div style={{ opacity: loading ? 0.5 : 1 }}>{chart}</div>
        )}

        {canEdit && sensors.length > 0 && (
          <div
            className="d-flex align-items-center gap-2 flex-wrap"
            style={{ background: 'var(--progeo-surface)', borderRadius: 12, padding: '8px 12px', fontSize: 12.5 }}
          >
            <span style={{ fontWeight: 500 }}>{t('einstell_mixer_selected', { count: selectedOrders.length })}</span>
            <PillButton variant="ghost" label={t('einstell_mixer_select_all')} onClick={() => setSelected(new Set(orders))} />
            <PillButton
              variant="ghost"
              label={t('einstell_mixer_select_over')}
              disabled={overCount === 0}
              onClick={() =>
                setSelected(new Set(sensors.filter((sensor) => isOver(sensor, savedObject, drafts)).map((s) => s.sensor_order)))
              }
            />
            <PillButton
              variant="ghost"
              label={t('einstell_mixer_select_none')}
              disabled={selectedOrders.length === 0}
              onClick={() => setSelected(new Set())}
            />
            <span style={{ flex: 1 }} />
            <input
              type="number"
              min={0}
              placeholder={t('einstell_points_threshold')}
              aria-label={t('einstell_mixer_bulk_value')}
              value={bulkValue}
              onChange={(event) => setBulkValue(event.target.value)}
              style={{
                height: 32,
                width: 110,
                border: 'none',
                borderRadius: 9,
                background: 'var(--progeo-track-soft)',
                padding: '0 10px',
                fontFamily: 'inherit',
                fontSize: 12.5,
              }}
            />
            <PillButton
              label={t('einstell_mixer_set_selected')}
              disabled={!bulkValid || selectedOrders.length === 0}
              onClick={() => bulkValid && setDrafts((prev) => withOverrides(prev, selectedOrders, bulkNumber))}
            />
            <PillButton
              variant="ghost"
              label={t('einstell_mixer_remove_selected')}
              disabled={
                selectedOrders.length === 0 ||
                !sensors.some((sensor) => selected.has(sensor.sensor_order) && overrideOf(sensor, drafts) != null)
              }
              onClick={() => setDrafts((prev) => withOverrides(prev, selectedOrders, null))}
            />
          </div>
        )}

        {canEdit && (
          <div className="d-flex gap-3 flex-wrap align-items-stretch">
            <div
              data-testid="threshold-changes"
              style={{
                flex: '1 1 320px',
                background: 'var(--progeo-surface)',
                borderRadius: 12,
                padding: '8px 12px',
                fontSize: 12.5,
                maxHeight: 170,
                overflowY: 'auto',
              }}
            >
              <div style={{ fontWeight: 500, marginBottom: 4 }}>
                {t('einstell_mixer_changes', { count: changes.length })}
              </div>
              {changes.length === 0 ? (
                <div style={{ color: MUTED }}>{t('einstell_mixer_no_changes')}</div>
              ) : (
                changes.map((change) => (
                  <div key={change.key} className="d-flex align-items-center gap-2" style={{ padding: '2px 0' }}>
                    <span style={{ fontWeight: 500, minWidth: 0, flex: '0 1 auto' }}>
                      {change.kind === 'object' ? t('einstell_mixer_object') : labelOf(change.sensorOrder)}
                    </span>
                    <span style={{ color: '#6E6868', fontVariantNumeric: 'tabular-nums' }}>{changeText(change)}</span>
                    <button
                      type="button"
                      title={t('einstell_mixer_undo')}
                      aria-label={t('einstell_mixer_undo')}
                      onClick={() => setDrafts((prev) => withoutChange(prev, change))}
                      style={{
                        marginLeft: 'auto',
                        border: 'none',
                        background: 'none',
                        color: MUTED,
                        padding: 2,
                        cursor: 'pointer',
                        display: 'inline-flex',
                      }}
                    >
                      <XLg size={11} />
                    </button>
                  </div>
                ))
              )}
            </div>
            <div className="d-flex flex-column gap-2 justify-content-end">
              <PillButton
                variant="accent"
                label={saving ? t('einstell_mixer_saving') : t('einstell_mixer_save', { count: changes.length })}
                disabled={saving || changes.length === 0}
                onClick={() => void save()}
              />
              <PillButton
                variant="ghost"
                icon={<ArrowCounterclockwise size={13} />}
                label={t('einstell_mixer_discard')}
                disabled={saving || (changes.length === 0 && drafts === NO_DRAFTS)}
                onClick={() => setDrafts(NO_DRAFTS)}
              />
            </div>
          </div>
        )}
      </div>
    </PanelCard>
  );
};

export default ThresholdMixerPanel;
