/**
 * The mouse on the plan canvas (ImageCanvasStage): what a press does in the
 * mode in use (insert, drag a group point, select an area, drag a sensor to
 * align, set the reference / a calibration point, drag or place a sensor -
 * else pan), what moving and releasing do, and the hovered sensor. The
 * middle button and Space + drag pan in every mode, F + drag picks an area
 * to zoom to; the right button is the browser's.
 */
import { useRef, useState, type RefObject } from 'react';
import type { PinDrag } from './drawImageCanvas';
import {
  canvasToFraction,
  canvasToImage,
  canvasToNormalized,
  clamp,
  CLICK_TOLERANCE,
  clientToCanvas,
  grabbedPoint,
  HOVER_TOLERANCE,
  nearestItem,
  normalizedToFraction,
  SENSOR_RADIUS,
  sensorAtPoint,
  type AlignmentValues,
  type CanvasLayout,
  type ImagePoint,
  type MarkerItem,
  type PlanImage,
  type PlanView,
  type PointTransform,
} from './imageCanvasGeometry';
import {
  alignKeyOf,
  canSelect,
  insertingOf,
  pressSelectMode,
  type CanvasModes,
  type SensorPlacement,
} from './imageCanvasModes';
import type { useAreaSelection, useGroupAlign, usePlanScale, usePointCalibration } from './useImageCanvasEdits';
import { useWindowPointer } from './useImageCanvasView';
import { areaOpOf, type SensorOrderRepair } from './useSensorOrderRepair';

type CanvasMouseEvent = React.MouseEvent<HTMLCanvasElement>;
type ClientPoint = { clientX: number; clientY: number };

export type Hover = { index: number; x: number; y: number };

type CanvasPointerInput = {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  modes: CanvasModes;
  placement?: SensorPlacement;
  image: PlanImage | null;
  layout: CanvasLayout | null;
  transform: PointTransform | null;
  alignment: AlignmentValues;
  view: PlanView;
  /** Canvas units per screen pixel / screen pixels per canvas unit. */
  px: number;
  screenScale: number;
  panTo: (x: number, y: number) => void;
  /** A pan ends (its last move shown now). */
  endPan: () => void;
  /** F + drag: the area shown while dragging, and the one let go (canvas units). */
  fit: {
    setBox: (box: [ImagePoint, ImagePoint] | null) => void;
    onDone: (box: [ImagePoint, ImagePoint]) => void;
  };
  /** The measure points as stored / as shown (a group being aligned moved). */
  items: MarkerItem[];
  shownItems: MarkerItem[];
  area: ReturnType<typeof useAreaSelection>;
  calibration: ReturnType<typeof usePointCalibration>;
  groupAlign: ReturnType<typeof useGroupAlign>;
  scale: ReturnType<typeof usePlanScale>;
  setHover: (update: Hover | null | ((current: Hover | null) => Hover | null)) => void;
  setInsertAt: (point: ImagePoint | null) => void;
  insertCut: (at: ImagePoint) => void;
  /** "Repair order": while it is on, the mouse is its own (areas, clicks, lines). */
  repair?: SensorOrderRepair;
};

export const useCanvasPointer = (input: CanvasPointerInput) => {
  const { canvasRef, modes, placement, layout, transform, area, calibration, groupAlign, scale, setHover } = input;
  const { group, groupDrag } = groupAlign;
  // Panning: where the press started and the pan then.
  const dragRef = useRef<{ startX: number; startY: number; startOffsetX: number; startOffsetY: number } | null>(null);
  // Whether a pan is going on - for the render (the cursor); the ref is for the handlers.
  const [panning, setPanning] = useState(false);
  // Placement: the sensor being dragged, and where a press on the plan
  // started (a click places, a drag pans).
  const sensorDragRef = useRef<number | null>(null);
  const pressRef = useRef<{ x: number; y: number } | null>(null);
  // F + drag: the area being dragged (canvas units).
  const fitRef = useRef<[ImagePoint, ImagePoint] | null>(null);

  // -- where the mouse is ----------------------------------------------------

  /** Canvas unit (logical) under the mouse - the canvas is shown at any width. */
  const canvasPointAt = (event: ClientPoint) => {
    const canvas = canvasRef.current;
    return canvas ? clientToCanvas(event, canvas.getBoundingClientRect()) : null;
  };
  /** Image pixel under the mouse: null outside the plan - or moved onto it (a selection ends at its edge). */
  const imagePointAt = (event: ClientPoint, onPlan = false) => {
    const at = canvasPointAt(event);
    return at && layout && input.image ? canvasToImage(at, layout, input.image, onPlan) : null;
  };
  /** Normalized position (nx/ny) under the mouse. */
  const normalizedPointAt = (event: ClientPoint) => {
    const at = canvasPointAt(event);
    return at && transform ? canvasToNormalized(at, transform) : null;
  };
  /** The placed sensor under the mouse (topmost), if any. */
  const sensorAt = (event: ClientPoint) => {
    const at = canvasPointAt(event);
    return placement && transform && at
      ? sensorAtPoint(placement.sensors, at, transform, (SENSOR_RADIUS + 3) * input.px)
      : null;
  };
  /** Index (into items) of the measure point / dm line under the mouse - the
   * closest within HOVER_TOLERANCE screen pixels - or null. */
  const itemAt = (event: ClientPoint) => {
    const at = canvasPointAt(event);
    return placement || !transform || !at ? null : nearestItem(input.shownItems, at, transform, HOVER_TOLERANCE * input.px);
  };
  /** "Align" (A, L): the sensor under the mouse (as shown) and the grabbed
   * point on it - normalized, as stored; on a dm line where it was grabbed. */
  const grabAt = (event: ClientPoint): PinDrag<'index'> | null => {
    const index = itemAt(event);
    const at = canvasPointAt(event);
    if (index === null || !transform || !at) {
      return null;
    }
    return { index, source: grabbedPoint(input.items[index], input.shownItems[index], at, transform), at };
  };

  // -- pressing on the plan: the first of these that takes the press, else it pans --

  // I held: a click inserts the cut points there.
  const pressInsert = (event: CanvasMouseEvent) => {
    if (!insertingOf(modes)) {
      return false;
    }
    const at = normalizedPointAt(event);
    if (at && !area.editBusy) {
      input.setInsertAt(at);
      input.insertCut(at);
    }
    return true;
  };

  // Group alignment (L): a press on one of its points drags it to its
  // place (elsewhere, or with Shift, it pans).
  const pressGroupPoint = (event: CanvasMouseEvent) => {
    if (!group || event.shiftKey || !input.image) {
      return false;
    }
    const grabbed = grabAt(event);
    const id = grabbed ? Number(input.items[grabbed.index].point.id) : NaN;
    if (!grabbed || !group.ids.has(id)) {
      return false;
    }
    const source = normalizedToFraction(grabbed.source, input.alignment, input.image);
    groupAlign.setGroupDrag({ id, source, at: grabbed.at });
    setHover(null);
    return true;
  };

  // Image edit (C / X) or a point selection (D / O / L held, then on until
  // its button, Cancel or Esc): a drag selects the area - a new one
  // replaces it, Shift + drag still pans.
  const pressSelect = (event: CanvasMouseEvent) => {
    const mode = pressSelectMode(modes);
    if (!mode || !canSelect(modes.caps, mode) || area.editBusy || event.shiftKey) {
      return false;
    }
    const at = imagePointAt(event, true);
    if (at) {
      area.startSelection(mode, at);
      setHover(null);
    }
    return true;
  };

  // A held: a press on a sensor drags it to its place (elsewhere it pans).
  const pressAlign = (event: CanvasMouseEvent) => {
    const grabbed = alignKeyOf(modes) && !group && scale.tool !== 'reference' ? grabAt(event) : null;
    if (!grabbed) {
      return false;
    }
    calibration.grab(grabbed);
    setHover(null);
    return true;
  };

  // R held (or the reference tool): a press sets the reference point;
  // M held: a press picks a calibration point.
  const pressScale = (event: CanvasMouseEvent) => {
    const reference = modes.heldKey === 'r' || scale.tool === 'reference';
    if (!modes.caps.canScale || !(reference || modes.heldKey === 'm')) {
      return false;
    }
    const at = imagePointAt(event);
    if (at) {
      (reference ? scale.setReference : scale.pickCalibration)(at);
    }
    return true;
  };

  // Placing sensors: a press on a placed one drags it; elsewhere a click
  // places the active one (see onClick) and a drag pans.
  const pressPlacement = (event: CanvasMouseEvent) => {
    if (!placement || scale.tool !== 'pan') {
      return false;
    }
    const sensor = sensorAt(event);
    if (sensor) {
      sensorDragRef.current = sensor.deviceId;
      placement.onSelect(sensor.deviceId);
      return true;
    }
    pressRef.current = { x: event.clientX, y: event.clientY };
    return false;
  };

  // -- moving ----------------------------------------------------------------

  /** A point being dragged onto its place (L, A) follows the mouse - true if one is. */
  const movePinDrag = (event: CanvasMouseEvent) => {
    const { alignDrag } = calibration;
    if (!groupDrag && !alignDrag) {
      return false;
    }
    const at = canvasPointAt(event);
    if (at && groupDrag) {
      groupAlign.setGroupDrag({ ...groupDrag, at });
    } else if (at && alignDrag) {
      calibration.setAlignDrag({ ...alignDrag, at });
    }
    return true;
  };

  /** A placed sensor being dragged follows the mouse, on the plan. */
  const moveSensor = (event: CanvasMouseEvent) => {
    if (!placement || sensorDragRef.current === null) {
      return;
    }
    const at = normalizedPointAt(event);
    if (at) {
      placement.onMove(sensorDragRef.current, clamp(at[0], 0, 1), clamp(at[1], 0, 1));
    }
  };

  /** The tooltip of the sensor under the mouse - none while panning. */
  const updateHover = (event: CanvasMouseEvent) => {
    const index = dragRef.current ? null : itemAt(event);
    if (index === null) {
      setHover((current) => (current ? null : current));
      return;
    }
    const bounds = event.currentTarget.getBoundingClientRect();
    setHover({ index, x: event.clientX - bounds.left, y: event.clientY - bounds.top });
  };

  // The mouse anywhere on the page: a selection being dragged moves its
  // second corner, a pan follows the mouse; released, drags end (off the
  // canvas the "Align" drag is dropped - on it, it is pinned first).
  useWindowPointer(
    (event) => {
      if (fitRef.current) {
        const at = canvasPointAt(event);
        if (at) {
          fitRef.current = [fitRef.current[0], at];
          input.fit.setBox(fitRef.current);
        }
        return;
      }
      if (input.repair?.draggingArea()) {
        const at = imagePointAt(event, true);
        if (at) {
          input.repair.extendArea(at);
        }
        return;
      }
      if (area.selectingRef.current) {
        const at = imagePointAt(event, true);
        if (at) {
          area.extendSelection(at);
        }
        return;
      }
      const drag = dragRef.current;
      if (drag) {
        // Mouse travel in screen pixels -> canvas units: the plan follows the mouse.
        input.panTo(
          drag.startOffsetX + (event.clientX - drag.startX) / input.screenScale,
          drag.startOffsetY + (event.clientY - drag.startY) / input.screenScale,
        );
      }
    },
    () => {
      if (dragRef.current) {
        dragRef.current = null;
        setPanning(false);
        input.endPan();
      }
      if (fitRef.current) {
        const box = fitRef.current;
        fitRef.current = null;
        input.fit.setBox(null);
        input.fit.onDone(box);
      }
      if (input.repair?.draggingArea()) {
        input.repair.finishArea();
      }
      area.endSelection();
      calibration.setAlignDrag(null);
      groupAlign.setGroupDrag(null);
      sensorDragRef.current = null;
    },
  );

  const startPan = (event: CanvasMouseEvent) => {
    dragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      startOffsetX: input.view.offsetX,
      startOffsetY: input.view.offsetY,
    };
    setPanning(true);
  };

  return {
    /** Panning, or dragging a point onto its place. */
    dragging: Boolean(panning || calibration.alignDrag || groupDrag),
    onMouseDown: (event: CanvasMouseEvent) => {
      pressRef.current = null;
      if (event.button > 1) {
        // The right button: the browser's context menu.
        return;
      }
      // The middle button (not the browser's auto-scroll) or Space: pan, in every mode.
      if (event.button === 1 || modes.heldKey === 'space') {
        event.preventDefault();
        startPan(event);
        setHover(null);
        return;
      }
      // F + drag: the area to zoom to.
      if (modes.heldKey === 'f') {
        const at = canvasPointAt(event);
        if (at) {
          fitRef.current = [at, at];
          input.fit.setBox(fitRef.current);
          setHover(null);
        }
        return;
      }
      const { repair } = input;
      if (repair?.active && repair.tool === 'area') {
        // Repair order, Area: a drag selects (Shift adds, Alt / Ctrl takes out).
        const at = imagePointAt(event, true);
        if (at) {
          repair.startArea(at, areaOpOf(event));
          setHover(null);
        }
        return;
      }
      // Repair order, the other tools: a click acts (see onClick), a drag pans.
      if (repair?.active) {
        pressRef.current = { x: event.clientX, y: event.clientY };
      }
      const presses = repair?.active
        ? []
        : [pressInsert, pressGroupPoint, pressSelect, pressAlign, pressScale, pressPlacement];
      if (!presses.some((press) => press(event))) {
        startPan(event);
      }
    },
    onMouseMove: (event: CanvasMouseEvent) => {
      if (area.selectingRef.current || fitRef.current) {
        return;
      }
      if (insertingOf(modes)) {
        input.setInsertAt(normalizedPointAt(event));
      }
      if (input.repair?.active && input.repair.lineStart) {
        input.repair.setMouse(normalizedPointAt(event));
      }
      if (movePinDrag(event)) {
        return;
      }
      moveSensor(event);
      updateHover(event);
    },
    // A dragged sensor dropped on the plan: pinned there (again, if it was).
    onMouseUp: () => {
      const drag = groupDrag ?? calibration.alignDrag;
      const target = drag && layout ? canvasToFraction(drag.at, layout) : null;
      if (groupDrag) {
        groupAlign.drop(target);
      } else if (calibration.alignDrag) {
        calibration.drop(target);
      }
    },
    onMouseLeave: () => setHover(null),
    // A click (not a pan) on the plan places the active sensor.
    onClick: (event: CanvasMouseEvent) => {
      const press = pressRef.current;
      pressRef.current = null;
      const clicked = press != null && Math.hypot(event.clientX - press.x, event.clientY - press.y) <= CLICK_TOLERANCE;
      if (input.repair?.active) {
        // Only a click pressed in this tool - not the end of an area's drag.
        if (clicked) {
          input.repair.click(itemAt(event), normalizedPointAt(event));
        }
        return;
      }
      if (
        !placement ||
        placement.activeDeviceId === null ||
        !press ||
        Math.hypot(event.clientX - press.x, event.clientY - press.y) > CLICK_TOLERANCE
      ) {
        return;
      }
      const at = normalizedPointAt(event);
      if (at && at.every((value) => value >= 0 && value <= 1)) {
        placement.onPlace(at[0], at[1]);
      }
    },
  };
};
