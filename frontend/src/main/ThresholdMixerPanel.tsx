import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Spinner } from 'react-bootstrap';
import { ArrowCounterclockwise, ChevronLeft, ChevronRight, XLg } from 'react-bootstrap-icons';
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
  gridValuesOf,
  isOver,
  isProtected,
  isQuiet,
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

const PERIODS = [1, 3, 7, 30, 90, 365];
/** Short by default - the maxima of long periods take a while. */
const DEFAULT_PERIOD = 3;

const MUTED = '#8B8383';
const BAR = '#A9BCCF';
const BAR_OVER = '#C44D26';
const OBJECT_LINE = 'var(--progeo-orange)';
const OWN = '#2a78d6';
const SELECTED_BG = 'rgba(42, 120, 214, .10)';
const HOVER_OUTLINE = '#0b3659';
const GRID = 'rgba(11, 54, 89, .08)';

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
/** How close (px) to a marker (or the object line) a press grabs it. */
const GRAB_PX = 11;
/** A press on a marker that moves less than this (px) is a click: it removes the marker. */
const CLICK_PX = 4;
/** Room under the plot for the horizontal scrollbar - it must not cover the labels. */
const SCROLLBAR_ROOM = 14;
/** ←/→ scroll this many columns (Shift: a page). */
const KEY_SCROLL_COLUMNS = 5;

/** `clicked`: the sensor whose own marker was pressed - a click without moving removes it. */
type Drag = { kind: 'object' } | { kind: 'sensors'; orders: number[]; clicked?: number };

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
 * them, each undoable - and only real changes are saved. `onSaved` follows
 * every save (e.g. the Analyse tab reloads what depends on the thresholds).
 */
const ThresholdMixerPanel = ({
  locationId,
  initialObjectThreshold,
  canEdit,
  onSaved,
  embedded = false,
  loaded = null,
}: {
  locationId: number | string;
  initialObjectThreshold: number | null;
  canEdit: boolean;
  onSaved?: () => void;
  /** Inside another panel (the Analyse tab's Störungsprofil): no card of its own. */
  embedded?: boolean;
  /**
   * The sensors from data the page already loaded (mixerSensorsFromLoaded) -
   * then nothing is requested and there is no period to pick; `note` says
   * where the maxima come from. Without: the panel loads GET measurepoints
   * with the period's maxima itself (the Einstellungen tab).
   */
  loaded?: { sensors: MixerSensor[]; note: string } | null;
}) => {
  const auth = useAuth();
  const { t } = useTranslation();
  const { enqueueSnackbar } = useSnackbar();

  const [days, setDays] = useState(DEFAULT_PERIOD);
  const [fetched, setFetched] = useState<MixerSensor[]>([]);
  const [loading, setLoading] = useState(loaded == null);
  // With `loaded`: the thresholds just saved, until the page's data has them.
  const [savedPatch, setSavedPatch] = useState<Record<number, number | null>>({});
  const loadedSensors = loaded?.sensors ?? null;
  const sensors = useMemo(
    () =>
      loadedSensors
        ? loadedSensors.map((sensor) =>
            sensor.sensor_order in savedPatch ? { ...sensor, threshold: savedPatch[sensor.sensor_order] } : sensor,
          )
        : fetched,
    [loadedSensors, savedPatch, fetched],
  );
  useEffect(() => {
    // The page reloaded its data: what it has now needs no patch any more.
    if (!loadedSensors) {
      return;
    }
    setSavedPatch((patch) => {
      const kept = Object.entries(patch).filter(
        ([order, value]) => loadedSensors.find((sensor) => sensor.sensor_order === Number(order))?.threshold !== value,
      );
      return kept.length === Object.keys(patch).length ? patch : Object.fromEntries(kept);
    });
  }, [loadedSensors]);
  // The press of a marker or the line: where it started and whether it moved.
  const pressRef = useRef<{ y: number; moved: boolean } | null>(null);
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
  // Hide the sensors that stay far below their threshold (isQuiet).
  const [hideQuiet, setHideQuiet] = useState(false);
  const [scroll, setScroll] = useState({ left: 0, client: 0, total: 0 });
  const stripesId = `mixer-protected-${useId().replace(/:/g, '')}`;
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
          setFetched(((response?.data?.sensors || []) as MixerSensor[]).map((sensor) => ({
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

  // Only without the page's data the panel loads its own.
  const fetchOwn = loaded == null;
  useEffect(() => {
    if (fetchOwn) {
      load(days);
    }
  }, [load, days, fetchOwn]);

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

  // Quiet by the saved thresholds - the columns don't jump while dragging.
  // Sensors with unsaved changes or selected stay, whatever their values.
  const quietOrders = useMemo(
    () => new Set(sensors.filter((sensor) => isQuiet(sensor, savedObject, NO_DRAFTS)).map((s) => s.sensor_order)),
    [sensors, savedObject],
  );
  const columns = hideQuiet
    ? sensors.filter(
        (sensor) =>
          !quietOrders.has(sensor.sensor_order) ||
          sensor.sensor_order in drafts.sensors ||
          selected.has(sensor.sensor_order),
      )
    : sensors;
  const orders = columns.map((sensor) => sensor.sensor_order);
  const count = Math.max(columns.length, 1);
  const fitColumn = Math.max(MIN_ZOOM_COLUMN, width / count);
  const defaultColumn = Math.min(MAX_COLUMN, Math.max(MIN_COLUMN, fitColumn));
  const column = zoomColumn != null ? Math.min(MAX_COLUMN, Math.max(Math.min(fitColumn, MIN_COLUMN), zoomColumn)) : defaultColumn;
  const plotWidth = Math.max(width, column * columns.length);

  // Where the scroller stands - for the "Sensoren x-y von n" line and the edge arrows.
  const measureScroll = useCallback(() => {
    const element = scrollerRef.current;
    if (element) {
      setScroll({ left: element.scrollLeft, client: element.clientWidth, total: element.scrollWidth });
    }
  }, []);
  useLayoutEffect(measureScroll, [measureScroll, plotWidth, loading]);

  const scrollBy = (pixels: number) => {
    const element = scrollerRef.current;
    if (!element) {
      return;
    }
    if (typeof element.scrollBy === 'function') {
      element.scrollBy({ left: pixels, behavior: 'smooth' });
    } else {
      element.scrollLeft += pixels;
    }
  };

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
    return { index, y: event.clientY - rect.top, sensor: columns[index] ?? null };
  };

  const grabAt = (sensor: MixerSensor | null, y: number): Drag | null => {
    if (!canEdit) {
      return null;
    }
    if (sensor) {
      const own = overrideOf(sensor, drafts);
      const isSelected = selected.has(sensor.sensor_order);
      const effective = effectiveThresholdOf(sensor, savedObject, drafts);
      // Its own marker - or, while selected, its spot on the object line.
      // Markers come first: where one is, the line is not grabbed.
      if ((own != null || isSelected) && effective != null && Math.abs(y - toY(effective)) <= GRAB_PX) {
        return {
          kind: 'sensors',
          orders: isSelected ? [...selected] : [sensor.sensor_order],
          ...(own != null ? { clicked: sensor.sensor_order } : {}),
        };
      }
    }
    // The object line itself - over the sensors as right of the last one.
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
    // The arrow keys scroll the focused plot.
    scrollerRef.current?.focus({ preventScroll: true });
    const { sensor, y } = pointerAt(event);
    const next = grabAt(sensor, y);
    if (next) {
      event.preventDefault();
      // Nothing moves until the pointer does - a click on a marker removes it.
      pressRef.current = { y, moved: false };
      startDrag(next, event.currentTarget, event.pointerId);
      return;
    }
    if (!sensor || !canEdit) {
      return;
    }
    const order = sensor.sensor_order;
    // Shift: select a range, Ctrl/⌘: add or remove one.
    if (event.shiftKey && anchor != null) {
      setSelected((prev) => new Set([...prev, ...rangeBetween(orders, anchor, order)]));
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      setSelected((prev) => {
        const toggled = new Set(prev);
        if (!toggled.delete(order)) {
          toggled.add(order);
        }
        return toggled;
      });
      setAnchor(order);
      return;
    }
    // A plain click sets the marker at the click's height (for the whole
    // selection if it holds this sensor) - and keeps dragging it.
    const targets = selected.has(order) ? [...selected] : [order];
    event.preventDefault();
    setDrafts((prev) => withOverrides(prev, targets, valueAt(y)));
    setAnchor(order);
    pressRef.current = { y, moved: true };
    startDrag({ kind: 'sensors', orders: targets }, event.currentTarget, event.pointerId);
  };

  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const { sensor, y } = pointerAt(event);
    if (drag) {
      const press = pressRef.current;
      if (press && !press.moved) {
        if (Math.abs(y - press.y) < CLICK_PX) {
          return;
        }
        press.moved = true;
      }
      applyDrag(drag, valueAt(y));
      return;
    }
    setHovered(sensor?.sensor_order ?? null);
    event.currentTarget.style.cursor = grabAt(sensor, y) ? 'ns-resize' : canEdit && sensor ? 'crosshair' : 'default';
  };

  const endDrag = () => {
    // A click on an own marker (pressed, not moved): it goes - the sensor
    // inherits the object's threshold again.
    const press = pressRef.current;
    if (drag?.kind === 'sensors' && drag.clicked != null && press && !press.moved) {
      const order = drag.clicked;
      setDrafts((prev) => withOverrides(prev, [order], null));
    }
    pressRef.current = null;
    setDrag(null);
    setFrozenScale(null);
  };

  // The object grip in the axis gutter: drag (or arrow keys) moves the line.
  const onGripDown = (event: PointerEvent<SVGElement>) => {
    if (!canEdit) {
      return;
    }
    event.preventDefault();
    pressRef.current = null;
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

  const onScrollerKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
      return;
    }
    event.preventDefault();
    const distance = event.shiftKey ? scroll.client * 0.9 : column * KEY_SCROLL_COLUMNS;
    scrollBy(event.key === 'ArrowLeft' ? -distance : distance);
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
      if (loaded) {
        setSavedPatch((patch) => ({
          ...patch,
          ...Object.fromEntries(payload.points.map((point) => [point.sensor_order, point.threshold])),
        }));
      } else {
        setLoading(true);
        load(days);
      }
      onSaved?.();
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
  const gridValues = gridValuesOf(scale / 1.15).filter((value) => value <= scale);
  const scrollable = scroll.total > scroll.client + 1;
  const atStart = scroll.left <= 1;
  const atEnd = scroll.left + scroll.client >= scroll.total - 1;
  const firstShown = Math.min(columns.length, Math.floor(scroll.left / column) + 1);
  const lastShown = Math.min(columns.length, Math.ceil((scroll.left + scroll.client) / column));
  const quietHidden = sensors.length - columns.length;

  const edge = (side: 'left' | 'right') => (
    <button
      type="button"
      aria-label={t(side === 'left' ? 'einstell_mixer_scroll_left' : 'einstell_mixer_scroll_right')}
      title={t(side === 'left' ? 'einstell_mixer_scroll_left' : 'einstell_mixer_scroll_right')}
      onClick={() => scrollBy((side === 'left' ? -1 : 1) * scroll.client * 0.9)}
      style={{
        position: 'absolute',
        top: 0,
        bottom: SCROLLBAR_ROOM,
        [side]: 0,
        width: 36,
        border: 'none',
        padding: 0,
        cursor: 'pointer',
        color: 'var(--progeo-blue)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: side === 'left' ? 'flex-start' : 'flex-end',
        background: `linear-gradient(to ${side === 'left' ? 'right' : 'left'}, var(--progeo-panel-bg, #fff) 25%, rgba(255,255,255,0))`,
        zIndex: 2,
      }}
    >
      {side === 'left' ? <ChevronLeft size={18} /> : <ChevronRight size={18} />}
    </button>
  );

  const chart = (
    <div style={{ display: 'flex', position: 'relative' }}>
      {/* The y-axis with the object grip stays put while the columns scroll. */}
      <svg width={GUTTER} height={SVG_H} style={{ flexShrink: 0, overflow: 'visible' }} aria-hidden={!canEdit}>
        {gridValues.map((tick) => (
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

      <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
      <div
        ref={scrollerRef}
        tabIndex={0}
        role="group"
        aria-label={t('einstell_mixer_plot_label')}
        onKeyDown={onScrollerKey}
        onScroll={measureScroll}
        style={{
          overflowX: 'auto',
          overflowY: 'hidden',
          paddingBottom: SCROLLBAR_ROOM,
          outline: 'none',
          scrollbarColor: `${MUTED} var(--progeo-track-soft)`,
        }}
      >
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
          <defs>
            {/* Protected by its own threshold, but above the object's: blue-red. */}
            <pattern id={stripesId} width={6} height={6} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width={3} height={6} fill={OWN} />
              <rect x={3} width={3} height={6} fill={BAR_OVER} />
            </pattern>
          </defs>
          {gridValues.map((value) => (
            <line key={value} x1={0} x2={plotWidth} y1={toY(value)} y2={toY(value)} stroke={GRID} />
          ))}
          <line x1={0} x2={plotWidth} y1={PLOT_TOP + PLOT_H} y2={PLOT_TOP + PLOT_H} stroke="var(--progeo-track)" />
          {columns.map((sensor, index) => {
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
                    data-bar
                    x={x + (column - barWidth) / 2}
                    y={toY(sensor.max)}
                    width={barWidth}
                    height={Math.max(1, PLOT_TOP + PLOT_H - toY(sensor.max))}
                    rx={Math.min(3, barWidth / 3)}
                    fill={
                      isOver(sensor, savedObject, drafts)
                        ? BAR_OVER
                        : isProtected(sensor, savedObject, drafts)
                          ? `url(#${stripesId})`
                          : BAR
                    }
                    stroke={hovered === order ? HOVER_OUTLINE : 'none'}
                    strokeWidth={hovered === order ? 1.5 : 0}
                  />
                )}
                {effective != null && (own != null || isSelected) && (
                  <rect
                    data-handle={order}
                    x={x + column * 0.05}
                    y={toY(effective) - 3}
                    width={column * 0.9}
                    height={6}
                    rx={3}
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
      {scrollable && !atStart && edge('left')}
      {scrollable && !atEnd && edge('right')}
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
          {canEdit && overrideOf(hoveredSensor, drafts) != null && (
            <div style={{ opacity: 0.7 }}>{t('einstell_mixer_marker_hint')}</div>
          )}
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
      flat={embedded}
      title={t('einstell_section_thresholds')}
      actions={
        loaded ? (
          // The page's own data - no period of its own to pick.
          <span style={{ fontSize: 12, color: MUTED }} data-testid="threshold-mixer-source">
            {loaded.note}
          </span>
        ) : (
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
        )
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
          {legendItem(
            <span
              style={{
                width: 10,
                height: 12,
                borderRadius: 2,
                background: `repeating-linear-gradient(45deg, ${OWN} 0 3px, ${BAR_OVER} 3px 6px)`,
              }}
            />,
            t('einstell_mixer_protected_legend'),
          )}
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
          <div style={{ opacity: loading ? 0.5 : 1 }}>
            <div className="d-flex align-items-center gap-2 flex-wrap mb-1" style={{ fontSize: 12, color: MUTED }}>
              <span data-testid="threshold-mixer-range">
                {scrollable
                  ? t('einstell_mixer_range', { first: firstShown, last: lastShown, total: columns.length })
                  : t('einstell_mixer_all_shown', { total: columns.length })}
                {quietHidden > 0 && ` · ${t('einstell_mixer_quiet_hidden', { count: quietHidden })}`}
              </span>
              <span style={{ flex: 1 }} />
              <PillButton
                variant={hideQuiet ? 'accent' : 'ghost'}
                label={t('einstell_mixer_hide_quiet', { count: quietOrders.size })}
                title={t('einstell_mixer_hide_quiet_hint', { percent: 5 })}
                disabled={quietOrders.size === 0 && !hideQuiet}
                onClick={() => setHideQuiet((hide) => !hide)}
              />
            </div>
            {chart}
          </div>
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
