/**
 * "Repair order" of ImageCanvasStage (sensorOrderRepair.ts): on / off, the
 * tool, the list of actions (undo drops the last), what the mouse is doing
 * and storing (measure_points/reorder). While it is on, its keys (A C L S Z
 * Esc) are the canvas' only ones - useHeldKey is switched off.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AuthContextType } from '../../../hooks/CoreAuthProvider';
import { postReorder } from './imageCanvasApi';
import { useLatestRef } from './useLatestRef';
import type { AlignmentValues, ImagePoint, MarkerItem, PlanImage, PointTransform } from './imageCanvasGeometry';
import {
  klemmlisteOf,
  LINE_SNAP,
  lineVerdict,
  openLines,
  pointsInArea,
  pointsOnLine,
  repairPointsOf,
  repairProblem,
  REPAIR_TOOL_KEYS,
  reorderPayload,
  replayRepair,
  type AreaOp,
  type RepairAction,
  type RepairTool,
} from './sensorOrderRepair';

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

/** The modifiers of a drag: Shift adds an area, Alt / Ctrl takes points out. */
export const areaOpOf = (event: { shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }): AreaOp =>
  event.shiftKey ? 'add' : event.altKey || event.ctrlKey || event.metaKey ? 'remove' : 'new';

export const useSensorOrderRepair = (input: {
  auth: AuthContextType;
  locationId?: number;
  /** The measure points as stored (numbers, names) and as shown. */
  items: MarkerItem[];
  shownItems: MarkerItem[];
  alignment: AlignmentValues;
  image: PlanImage | null;
  transform: PointTransform | null;
  /** Canvas units per screen pixel. */
  px: number;
  onStored?: (response: Record<string, unknown>) => void;
}) => {
  const { items, shownItems, alignment, image, transform, px } = input;
  const [active, setActive] = useState(false);
  const [tool, setTool] = useState<RepairTool>('area');
  const [actions, setActions] = useState<RepairAction[]>([]);
  // A line's first click and the mouse (normalized), the first point of a swap (id).
  const [lineStart, setLineStart] = useState<ImagePoint | null>(null);
  const [mouse, setMouse] = useState<ImagePoint | null>(null);
  const [swapFirst, setSwapFirst] = useState<number | null>(null);
  // An area being dragged (image pixels) - the ref at once (the window's mouse
  // may move before the next render), the state for drawing.
  type AreaDrag = { from: ImagePoint; to: ImagePoint; op: AreaOp };
  const [areaDrag, setAreaDragState] = useState<AreaDrag | null>(null);
  const areaDragRef = useRef<AreaDrag | null>(null);
  const setAreaDrag = (drag: AreaDrag | null) => {
    areaDragRef.current = drag;
    setAreaDragState(drag);
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const points = useMemo(() => repairPointsOf(items), [items]);
  const result = useMemo(() => replayRepair(actions, points), [actions, points]);
  const klemmliste = useMemo(() => (result.total ? klemmlisteOf(points, result.pool) : null), [points, result]);
  const verdicts = useMemo(
    () =>
      klemmliste
        ? result.lines.map((ids) => lineVerdict(ids.map((id) => result.numbers.get(id) ?? 0), klemmliste))
        : [],
    [klemmliste, result],
  );
  const open = klemmliste ? openLines(result, klemmliste, verdicts) : [];

  /** The area points without a number yet - what a line / click can still take. */
  const unnumbered = useMemo(
    () => new Set([...result.area].filter((id) => !result.numbers.has(id))),
    [result],
  );
  const preview = useMemo(
    () =>
      active && tool === 'line' && lineStart && mouse && transform
        ? pointsOnLine(shownItems, unnumbered, lineStart, mouse, transform, LINE_SNAP * px)
        : [],
    [active, tool, lineStart, mouse, transform, shownItems, unnumbered, px],
  );
  const previewVerdict = useMemo(() => {
    if (!klemmliste || !preview.length) {
      return null;
    }
    // The numbers the line would hand out: the free ones of the pool, in order.
    const held = new Set(result.numbers.values());
    const numbers = result.pool.filter((order) => !held.has(order)).slice(0, preview.length);
    return numbers.length === preview.length ? lineVerdict(numbers, klemmliste) : null;
  }, [klemmliste, preview, result]);

  const push = (action: RepairAction) => setActions((current) => [...current, action]);
  const clearPending = () => {
    setLineStart(null);
    setSwapFirst(null);
  };
  const reset = () => {
    setActions([]);
    clearPending();
    setAreaDrag(null);
    setTool('area');
    setError('');
  };
  const undo = () => {
    clearPending();
    setActions((current) => current.slice(0, -1));
  };
  const pickTool = (next: RepairTool) => {
    clearPending();
    setTool(next);
  };

  // The repair's keys while it is on.
  const keyRef = useLatestRef({ pickTool, undo, clearPending, hasPending: lineStart != null || swapFirst != null });
  useEffect(() => {
    if (!active) {
      return undefined;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTyping(event.target) || event.altKey) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key === 'z') {
        event.preventDefault();
        keyRef.current.undo();
      } else if (key === 'escape') {
        keyRef.current.clearPending();
        setAreaDrag(null);
      } else if (!event.ctrlKey && !event.metaKey && REPAIR_TOOL_KEYS[key]) {
        keyRef.current.pickTool(REPAIR_TOOL_KEYS[key]);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [active, keyRef]);

  const finishArea = () => {
    const drag = areaDragRef.current;
    setAreaDrag(null);
    if (!drag || !image) {
      return;
    }
    const box: [ImagePoint, ImagePoint] = [drag.from, drag.to];
    const ids = pointsInArea(shownItems, box, alignment, image);
    if (!ids.length) {
      return;
    }
    push({ type: 'area', op: drag.op, box, ids });
    // A new selection goes on with its lines.
    if (drag.op === 'new') {
      setTool('line');
    }
  };

  /** A click on the plan: `index` the point under the mouse (into items), `at` normalized. */
  const click = (index: number | null, at: ImagePoint | null) => {
    const id = index != null ? Number(items[index]?.point.id) : null;
    if (tool === 'click' && id != null && unnumbered.has(id)) {
      push({ type: 'assign', how: 'click', ids: [id] });
    } else if (tool === 'swap' && id != null) {
      if (swapFirst == null) {
        setSwapFirst(id);
      } else if (swapFirst !== id) {
        push({ type: 'swap', a: swapFirst, b: id });
        setSwapFirst(null);
      }
    } else if (tool === 'line') {
      // A click on a point starts / ends the line right on it.
      const point = index != null && items[index] ? items[index].start : at;
      if (!point || !result.total) {
        return;
      }
      if (!lineStart) {
        setLineStart(point);
      } else {
        if (preview.length) {
          push({ type: 'assign', how: 'line', ids: preview });
        }
        setLineStart(null);
      }
    }
  };

  const problem = result.total || actions.length ? repairProblem(result, points) : null;
  const store = () => {
    if (input.locationId == null || problem) {
      return;
    }
    setBusy(true);
    setError('');
    postReorder(
      input.auth,
      input.locationId,
      reorderPayload(result, points),
      (answer) => {
        setBusy(false);
        reset();
        setActive(false);
        input.onStored?.(answer);
      },
      (message) => {
        setBusy(false);
        setError(message);
      },
    );
  };

  return {
    active,
    start: () => {
      reset();
      setActive(true);
    },
    leave: () => {
      reset();
      setActive(false);
    },
    tool,
    pickTool,
    actions,
    undo,
    result,
    klemmliste,
    verdicts,
    open,
    preview,
    previewVerdict,
    lineStart,
    mouse,
    setMouse,
    swapFirst,
    areaDrag,
    startArea: (at: ImagePoint, op: AreaOp) => setAreaDrag({ from: at, to: at, op }),
    extendArea: (at: ImagePoint) => {
      if (areaDragRef.current) {
        setAreaDrag({ ...areaDragRef.current, to: at });
      }
    },
    finishArea,
    /** An area is being dragged (the window's mouse extends it). */
    draggingArea: () => areaDragRef.current != null,
    click,
    problem,
    store,
    busy,
    error,
  };
};

export type SensorOrderRepair = ReturnType<typeof useSensorOrderRepair>;
