import {
  type Dispatch,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
  type SetStateAction,
  useRef,
  useState,
} from 'react';
import { type MixerSensor, objectThresholdOf, type ThresholdDrafts, withOverrides } from './thresholdMixer';
import {
  clickedBarOf,
  clickedMarkerOf,
  cursorOf,
  type Drag,
  grabOf,
  type MixerState,
  nudgedValue,
  onBarOf,
  type Press,
  stillAClick,
  withToggledDisabled,
  yAxisOf,
} from './thresholdMixerView';

type Selection = {
  setAnchor: (order: number) => void;
  selectByClick: (modifiers: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }, order: number, orders: number[]) => boolean;
};

const capture = (target: Element, pointerId: number) => {
  try {
    target.setPointerCapture(pointerId);
  } catch {
    // jsdom / old browsers: the drag still works while over the plot.
  }
};

/**
 * The plot's pointer and keys: a press grabs a marker or the object line
 * (and drags it), else selects (Shift / Ctrl/⌘) or sets a marker at the
 * press's height and keeps dragging it. A marker pressed and released
 * without moving goes. The y-scale stays put while dragging - it would jump
 * under the pointer. Returns the scale in use and the handlers of the plot
 * and of the object grip in the axis.
 */
const useThresholdMixerDrag = ({
  canEdit,
  columns,
  column,
  state,
  liveScale,
  setDrafts,
  selection,
  scrollerRef,
}: {
  canEdit: boolean;
  columns: MixerSensor[];
  column: number;
  state: MixerState;
  liveScale: number;
  setDrafts: Dispatch<SetStateAction<ThresholdDrafts>>;
  selection: Selection;
  scrollerRef: RefObject<HTMLDivElement | null>;
}) => {
  const pressRef = useRef<Press | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [frozenScale, setFrozenScale] = useState<number | null>(null);
  const scale = frozenScale ?? liveScale;
  const { step, toY, valueAt } = yAxisOf(scale);
  const objectThreshold = objectThresholdOf(state.savedObject, state.drafts);
  const { selected } = state;

  const pointerAt = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const index = Math.floor((event.clientX - rect.left) / column);
    return { y: event.clientY - rect.top, sensor: columns[index] ?? null };
  };

  const grabAt = (sensor: MixerSensor | null, y: number) =>
    canEdit ? grabOf(sensor, y, state, objectThreshold, toY) : null;

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
    capture(target, pointerId);
  };

  // A plain click above a bar sets the marker at the click's height (for the
  // whole selection if it holds this sensor) - and keeps dragging it. On the
  // bar nothing changes until the pointer moves: then the marker is dragged
  // out of it, a click without moving switches the sensor off / on (endDrag).
  const pressColumn = (event: PointerEvent<SVGSVGElement>, sensor: MixerSensor, y: number) => {
    const order = sensor.sensor_order;
    const targets = selected.has(order) ? [...selected] : [order];
    const onBar = onBarOf(sensor, y, toY);
    event.preventDefault();
    if (!onBar) {
      setDrafts((prev) => withOverrides(prev, targets, valueAt(y)));
    }
    selection.setAnchor(order);
    pressRef.current = { y, moved: !onBar };
    startDrag(
      { kind: 'sensors', orders: targets, ...(onBar ? { toggles: order } : {}) },
      event.currentTarget,
      event.pointerId,
    );
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
    const orders = columns.map((candidate) => candidate.sensor_order);
    if (!selection.selectByClick(event, sensor.sensor_order, orders)) {
      pressColumn(event, sensor, y);
    }
  };

  const overOf = (sensor: MixerSensor | null, y: number) => {
    if (!sensor) {
      return null;
    }
    return onBarOf(sensor, y, toY) ? 'bar' : 'column';
  };

  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const { sensor, y } = pointerAt(event);
    if (drag) {
      if (!stillAClick(pressRef.current, y)) {
        applyDrag(drag, valueAt(y));
      }
      return;
    }
    setHovered(sensor?.sensor_order ?? null);
    event.currentTarget.style.cursor = cursorOf(grabAt(sensor, y) != null, canEdit, overOf(sensor, y));
  };

  const endDrag = () => {
    // A click on an own marker (pressed, not moved): it goes - the sensor
    // inherits the object's threshold again.
    const clicked = clickedMarkerOf(drag, pressRef.current);
    if (clicked != null) {
      setDrafts((prev) => withOverrides(prev, [clicked], null));
    }
    // A click on a bar: the sensor is switched off / on (a draft, like the selection's tools).
    const toggled = columns.find((sensor) => sensor.sensor_order === clickedBarOf(drag, pressRef.current));
    if (toggled) {
      setDrafts((prev) => withToggledDisabled(prev, toggled));
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
  const onGripKey = (event: KeyboardEvent) => {
    const value = canEdit ? nudgedValue(event.key, event.shiftKey, objectThreshold, step) : undefined;
    if (value !== undefined) {
      event.preventDefault();
      setDrafts((prev) => ({ ...prev, object: value }));
    }
  };

  return {
    scale,
    step,
    toY,
    drag,
    hovered,
    plotHandlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
      onPointerLeave: () => !drag && setHovered(null),
    },
    gripHandlers: {
      onPointerDown: onGripDown,
      onPointerMove: onGripMove,
      onPointerUp: endDrag,
      onKeyDown: onGripKey,
    },
  };
};

export default useThresholdMixerDrag;
