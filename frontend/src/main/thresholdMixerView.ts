/**
 * What ThresholdMixerPanel draws and how a press on it reads - pure, beside
 * the threshold logic itself (thresholdMixer.ts): colours and geometry of the
 * plot, its y-scale, which columns it shows, what a press grabs, and the
 * patch that holds just-saved values until the page's data has them.
 */
import type { TFunction } from 'i18next';
import { DISABLED_SENSOR_FILL } from '../components/device/disabledSensors';
import {
  effectiveThresholdOf,
  gridValuesOf,
  isDisabled,
  isOver,
  isProtected,
  isQuiet,
  type MixerSensor,
  NO_DRAFTS,
  overrideOf,
  type PointPayload,
  snapped,
  snapStepOf,
  type ThresholdChange,
  type ThresholdDrafts,
  withDisabled,
} from './thresholdMixer';

export const PERIODS = [1, 3, 7, 30, 90, 365];
/** Short by default - the maxima of long periods take a while. */
export const DEFAULT_PERIOD = 3;

export const MUTED = '#8B8383';
export const BAR = '#A9BCCF';
export const BAR_OVER = '#C44D26';
export const OBJECT_LINE = 'var(--progeo-orange)';
export const OWN = '#2a78d6';
export const SELECTED_BG = 'rgba(42, 120, 214, .10)';
export const HOVER_BG = 'rgba(11, 54, 89, .04)';
export const HOVER_OUTLINE = '#0b3659';
export const GRID = 'rgba(11, 54, 89, .08)';

// Geometry (px): the plot area, the y-axis gutter left of the scroller.
export const PLOT_TOP = 10;
export const PLOT_H = 230;
const AXIS_H = 26;
export const SVG_H = PLOT_TOP + PLOT_H + AXIS_H;
export const PLOT_BOTTOM = PLOT_TOP + PLOT_H;
export const GUTTER = 58;
/** How close (px) to a marker (or the object line) a press grabs it. */
const GRAB_PX = 11;
/** A press on a marker that moves less than this (px) is a click: it removes the marker. */
const CLICK_PX = 4;
/** ←/→ scroll this many columns (Shift: a page). */
const KEY_SCROLL_COLUMNS = 5;

/** `clicked`: the sensor whose own marker was pressed - a click without moving removes it.
 * `toggles`: the sensor whose bar was pressed - a click without moving switches it off / on,
 * moving drags a new marker out of it. */
export type Drag =
  | { kind: 'object' }
  | { kind: 'sensors'; orders: number[]; clicked?: number; toggles?: number };

/** The press of a marker or the line: where it started and whether it moved. */
export type Press = { y: number; moved: boolean };

/** What the plot draws from: the drafts over the saved thresholds, and the selection. */
export type MixerState = {
  drafts: ThresholdDrafts;
  savedObject: number | null;
  selected: ReadonlySet<number>;
};

export const formatValue = (value: number | null) => (value == null ? '–' : String(Math.round(value * 10) / 10));

/** The y-scale's top: the highest maximum or threshold plus some headroom. */
export const liveScaleOf = (sensors: MixerSensor[], savedObject: number | null, drafts: ThresholdDrafts) => {
  const values = sensors.flatMap((sensor) => [sensor.max, effectiveThresholdOf(sensor, savedObject, drafts)]);
  return Math.max(1, ...values.filter((value): value is number => value != null)) * 1.15;
};

/** The grid's round values within the scale (it has 15 % headroom over the data). */
export const gridOf = (scale: number) => gridValuesOf(scale / 1.15).filter((value) => value <= scale);

/** The y-axis of `scale`: value -> y (clipped at the top) and y -> snapped value. */
export const yAxisOf = (scale: number) => {
  const step = snapStepOf(scale);
  return {
    step,
    toY: (value: number) => PLOT_BOTTOM - (Math.min(value, scale) / scale) * PLOT_H,
    valueAt: (y: number) => snapped(((PLOT_BOTTOM - y) / PLOT_H) * scale, step),
  };
};

/** Quiet by the saved thresholds - the columns don't jump while dragging. */
export const quietOrdersOf = (sensors: MixerSensor[], savedObject: number | null) =>
  new Set(sensors.filter((sensor) => isQuiet(sensor, savedObject, NO_DRAFTS)).map((sensor) => sensor.sensor_order));

/** The plot's columns: with `hideQuiet` without the quiet sensors - but
 * sensors with unsaved changes or selected stay, whatever their values. */
export const visibleColumnsOf = (
  sensors: MixerSensor[],
  hideQuiet: boolean,
  quietOrders: ReadonlySet<number>,
  { drafts, selected }: Pick<MixerState, 'drafts' | 'selected'>,
) =>
  hideQuiet
    ? sensors.filter(
        ({ sensor_order: order }) => !quietOrders.has(order) || order in drafts.sensors || selected.has(order),
      )
    : sensors;

/** The legend's counts: over their threshold, with an own one, switched off. */
export const mixerCountsOf = (sensors: MixerSensor[], savedObject: number | null, drafts: ThresholdDrafts) => ({
  over: sensors.filter((sensor) => isOver(sensor, savedObject, drafts)).length,
  own: sensors.filter((sensor) => overrideOf(sensor, drafts) != null).length,
  disabled: sensors.filter((sensor) => isDisabled(sensor, drafts)).length,
});

export const overOrdersOf = (sensors: MixerSensor[], savedObject: number | null, drafts: ThresholdDrafts) =>
  sensors.filter((sensor) => isOver(sensor, savedObject, drafts)).map((sensor) => sensor.sensor_order);

/** What the selection tools can do: remove own thresholds, switch off, switch on. */
export const selectionFlagsOf = (
  sensors: MixerSensor[],
  selected: ReadonlySet<number>,
  drafts: ThresholdDrafts,
) => {
  const chosen = sensors.filter((sensor) => selected.has(sensor.sensor_order));
  return {
    anyOwn: chosen.some((sensor) => overrideOf(sensor, drafts) != null),
    anyEnabled: chosen.some((sensor) => !isDisabled(sensor, drafts)),
    anyDisabled: chosen.some((sensor) => isDisabled(sensor, drafts)),
  };
};

/** The typed bulk value - null unless a number ≥ 0. */
export const bulkNumberOf = (text: string) => {
  const value = text.trim() === '' ? null : Number(text);
  return value != null && Number.isFinite(value) && value >= 0 ? value : null;
};

/** A bar's fill: grey when off, red when over, striped when protected by its own threshold. */
export const barFillOf = (sensor: MixerSensor, { drafts, savedObject }: Omit<MixerState, 'selected'>, stripesId: string) => {
  if (isDisabled(sensor, drafts)) {
    return DISABLED_SENSOR_FILL;
  }
  if (isOver(sensor, savedObject, drafts)) {
    return BAR_OVER;
  }
  return isProtected(sensor, savedObject, drafts) ? `url(#${stripesId})` : BAR;
};

/** The sensor's marker under `y`: its own - or, while selected, its spot on the object line. */
const markerGrabOf = (sensor: MixerSensor, y: number, state: MixerState, toY: (value: number) => number): Drag | null => {
  const { drafts, savedObject, selected } = state;
  const own = overrideOf(sensor, drafts);
  const isSelected = selected.has(sensor.sensor_order);
  const effective = effectiveThresholdOf(sensor, savedObject, drafts);
  if ((own == null && !isSelected) || effective == null || Math.abs(y - toY(effective)) > GRAB_PX) {
    return null;
  }
  return {
    kind: 'sensors',
    orders: isSelected ? [...selected] : [sensor.sensor_order],
    ...(own != null ? { clicked: sensor.sensor_order } : {}),
  };
};

/**
 * What a press at `y` over `sensor` grabs. Markers come first: where one is,
 * the line is not grabbed. The object line is grabbed over the sensors as
 * right of the last one (`sensor` null).
 */
export const grabOf = (
  sensor: MixerSensor | null,
  y: number,
  state: MixerState,
  objectThreshold: number | null,
  toY: (value: number) => number,
): Drag | null => {
  const marker = sensor ? markerGrabOf(sensor, y, state, toY) : null;
  if (marker) {
    return marker;
  }
  return objectThreshold != null && Math.abs(y - toY(objectThreshold)) <= GRAB_PX ? { kind: 'object' } : null;
};

/** A press that has not moved yet stays a click while within CLICK_PX - else it starts moving (marked on `press`). */
export const stillAClick = (press: Press | null, y: number) => {
  if (!press || press.moved) {
    return false;
  }
  if (Math.abs(y - press.y) < CLICK_PX) {
    return true;
  }
  press.moved = true;
  return false;
};

/** The sensor whose own marker was clicked (pressed, not moved) - it loses the marker. */
export const clickedMarkerOf = (drag: Drag | null, press: Press | null) =>
  drag?.kind === 'sensors' && drag.clicked != null && press && !press.moved ? drag.clicked : null;

/** The sensor whose bar was clicked (pressed, not moved) - it is switched off / on. */
export const clickedBarOf = (drag: Drag | null, press: Press | null) =>
  drag?.kind === 'sensors' && drag.toggles != null && press && !press.moved ? drag.toggles : null;

/** A thin bar stays clickable: this much (px) above its top still counts. */
const BAR_SLACK_PX = 3;

/** `y` lies on the sensor's bar (the column's width, from the bar's top down to the base line). */
export const onBarOf = (sensor: MixerSensor, y: number, toY: (value: number) => number) =>
  sensor.max != null && y >= toY(sensor.max) - BAR_SLACK_PX && y <= PLOT_BOTTOM;

/** The drafts with the sensor switched off - or on again if it is off. */
export const withToggledDisabled = (drafts: ThresholdDrafts, sensor: MixerSensor) =>
  withDisabled(drafts, [sensor.sensor_order], !isDisabled(sensor, drafts));

/** Where the pointer is: on a marker / the line (grab), on a bar (toggle), in a column (set a marker). */
export const cursorOf = (grabbable: boolean, canEdit: boolean, over: 'bar' | 'column' | null) => {
  if (grabbable) {
    return 'ns-resize';
  }
  if (!canEdit || over == null) {
    return 'default';
  }
  return over === 'bar' ? 'pointer' : 'crosshair';
};

/** ↑/↓ move a value by a step (Shift: ten) - undefined for other keys. */
export const nudgedValue = (key: string, shiftKey: boolean, current: number | null, step: number) => {
  if (key !== 'ArrowUp' && key !== 'ArrowDown') {
    return undefined;
  }
  const by = (shiftKey ? 10 : 1) * step;
  return snapped((current ?? 0) + (key === 'ArrowUp' ? by : -by), step);
};

/** ←/→ scroll by KEY_SCROLL_COLUMNS columns (Shift: most of a page) - null for other keys. */
export const keyScrollOf = (key: string, shiftKey: boolean, client: number, column: number) => {
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') {
    return null;
  }
  const distance = shiftKey ? client * 0.9 : column * KEY_SCROLL_COLUMNS;
  return key === 'ArrowLeft' ? -distance : distance;
};

export type ScrollState = { left: number; client: number; total: number };

/** Where the scroller stands: for the "Sensoren x-y von n" line and the edge arrows. */
export const scrollViewOf = (scroll: ScrollState, column: number, count: number) => ({
  scrollable: scroll.total > scroll.client + 1,
  atStart: scroll.left <= 1,
  atEnd: scroll.left + scroll.client >= scroll.total - 1,
  firstShown: Math.min(count, Math.floor(scroll.left / column) + 1),
  lastShown: Math.min(count, Math.ceil((scroll.left + scroll.client) / column)),
});

/** `set` with `order` added - or removed if it was in. */
export const toggledIn = (set: ReadonlySet<number>, order: number) => {
  const toggled = new Set(set);
  if (!toggled.delete(order)) {
    toggled.add(order);
  }
  return toggled;
};

/** With the page's data: the thresholds / states just saved, per sensor. */
export type SavedPatch = Record<number, Partial<Pick<MixerSensor, 'threshold' | 'disabled'>>>;

export const patchedSensors = (sensors: MixerSensor[], patch: SavedPatch) =>
  sensors.map((sensor) => (sensor.sensor_order in patch ? { ...sensor, ...patch[sensor.sensor_order] } : sensor));

/** The patch without what the page's (reloaded) data has by now - the same object if nothing goes. */
export const prunedPatch = (patch: SavedPatch, sensors: MixerSensor[]) => {
  const kept = Object.entries(patch).filter(([order, values]) => {
    const sensor = sensors.find((candidate) => candidate.sensor_order === Number(order));
    return Object.entries(values).some(
      ([key, value]) => (key === 'disabled' ? Boolean(sensor?.disabled) : sensor?.threshold) !== value,
    );
  });
  return kept.length === Object.keys(patch).length ? patch : (Object.fromEntries(kept) as SavedPatch);
};

export const withSavedPoints = (patch: SavedPatch, points: PointPayload[]) => {
  const next = { ...patch };
  points.forEach(({ sensor_order: order, ...values }) => {
    next[order] = { ...next[order], ...values };
  });
  return next;
};

/** The sensor's name - or "Sensor <order>". */
export const sensorLabelOf = (sensors: MixerSensor[], order: number, t: TFunction) =>
  sensors.find((sensor) => sensor.sensor_order === order)?.name || t('einstell_points_sensor', { sensor: order });

/** "from → to" of a pending change; a sensor without an own value inherits the object's. */
export const changeTextOf = (change: ThresholdChange, objectThreshold: number | null, t: TFunction) => {
  if (change.kind === 'disabled') {
    return change.to ? t('einstell_mixer_change_disabled') : t('einstell_mixer_change_enabled');
  }
  const none =
    change.kind === 'object'
      ? t('einstell_mixer_none')
      : t('einstell_mixer_inherits', { value: formatValue(objectThreshold) });
  const shown = (value: number | null) => (value == null ? none : `${formatValue(value)} mV`);
  return `${shown(change.from)} → ${shown(change.to)}`;
};
