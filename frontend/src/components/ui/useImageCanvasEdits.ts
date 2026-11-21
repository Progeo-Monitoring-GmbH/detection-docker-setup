/**
 * Hooks of the plan canvas (ImageCanvasStage) for what is edited on it: the
 * point alignment (sliders, stored by itself), the point calibration (A),
 * the group alignment (L), the metric scale and the selected area (C / X /
 * D / O / L).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fitAlignment, type AlignPin } from './alignmentFit';
import type { PinDrag } from './drawImageCanvas';
import { fitGroup, type GroupPin } from './groupAlign';
import {
  alignmentBaseScale,
  calibrationDistance,
  cutItemsOf,
  cutPlacedAt,
  markerItems,
  onPlanFraction,
  pointIdsOf,
  positiveNumber,
  sameAlignment,
  selectedItemsOf,
  selectionRect,
  shownItemsOf,
  storedAlignment,
  type AlignmentValues,
  type ImagePoint,
  type PlanImage,
} from './imageCanvasGeometry';
import { pointSelectOf, type CanvasTool, type ImageEdit, type SelectMode } from './imageCanvasModes';

/** Delay (ms) after the last change of the alignment before it is stored. */
const ALIGN_STORE_DELAY = 600;

type PlanMeta = Parameters<typeof storedAlignment>[0] & {
  reference_x?: number | null;
  reference_y?: number | null;
  meters_per_pixel?: number | null;
};

/** The point alignment of the sliders - from the plan, flipped unless it says
 * otherwise (the wizard's default). */
export const usePointAlignment = (sourceMeta: PlanMeta | undefined) => {
  const [initial] = useState(() => storedAlignment(sourceMeta, true));
  const [offsetX, setOffsetX] = useState(initial.offsetX);
  const [offsetY, setOffsetY] = useState(initial.offsetY);
  const [scaleX, setScaleX] = useState(initial.scaleX);
  const [scaleY, setScaleY] = useState(initial.scaleY);
  const [flipY, setFlipY] = useState(initial.flipY);
  const alignment = useMemo<AlignmentValues>(
    () => ({ offsetX, offsetY, scaleX, scaleY, flipY }),
    [offsetX, offsetY, scaleX, scaleY, flipY],
  );
  /** Shows (and so stores, see useAlignmentAutoStore) an alignment on the sliders. */
  const show = useCallback((values: AlignmentValues) => {
    setOffsetX(values.offsetX);
    setOffsetY(values.offsetY);
    setScaleX(values.scaleX);
    setScaleY(values.scaleY);
    setFlipY(values.flipY);
  }, []);
  return { alignment, show, setOffsetX, setOffsetY, setScaleX, setScaleY, setFlipY };
};

/** The alignment is stored by itself (`store`), a moment after the last
 * change; one still pending is stored when the plan is left. */
export const useAlignmentAutoStore = (
  enabled: boolean,
  alignment: AlignmentValues,
  initial: AlignmentValues,
  store: (values: AlignmentValues) => void,
) => {
  const storedRef = useRef<AlignmentValues>(initial);
  const pendingRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!enabled || sameAlignment(alignment, storedRef.current)) {
      pendingRef.current = null;
      return undefined;
    }
    const storeNow = () => {
      pendingRef.current = null;
      // Stored meanwhile with an image edit - a crop has moved it since.
      if (sameAlignment(alignment, storedRef.current)) {
        return;
      }
      storedRef.current = alignment;
      store(alignment);
    };
    pendingRef.current = storeNow;
    const timer = window.setTimeout(storeNow, ALIGN_STORE_DELAY);
    return () => window.clearTimeout(timer);
    // store changes every render - the values decide.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, alignment]);
  useEffect(() => () => pendingRef.current?.(), []);
  return {
    /** The alignment is stored (with an image edit) - not again by itself. */
    markStored: (values: AlignmentValues) => {
      storedRef.current = values;
    },
    /** A store still pending must not follow. */
    dropPending: () => {
      pendingRef.current = null;
    },
  };
};

/** Point calibration: while A is held, a sensor dragged onto its place on the
 * plan is pinned there - from the pins (by index into the items) the
 * alignment is computed (alignmentFit) and shown; the values before are
 * restored on cancel. */
export const usePointCalibration = (
  image: PlanImage | null,
  alignment: AlignmentValues,
  show: (values: AlignmentValues) => void,
) => {
  const [pins, setPins] = useState<Array<AlignPin & { index: number }>>([]);
  // The sensor being dragged, the grabbed point on it (normalized) and the mouse (canvas units).
  const [alignDrag, setAlignDrag] = useState<PinDrag<'index'> | null>(null);
  const [alignBefore, setAlignBefore] = useState<AlignmentValues | null>(null);
  const aligning = pins.length > 0 || alignDrag != null;

  // The alignment of the pins, applied to the sliders as soon as it can be computed.
  const alignFit = useMemo(
    () =>
      aligning && image
        ? fitAlignment(
            pins,
            image.naturalWidth,
            image.naturalHeight,
            alignmentBaseScale(image.naturalWidth, image.naturalHeight),
          )
        : null,
    [aligning, image, pins],
  );
  useEffect(() => {
    if (alignFit && 'alignment' in alignFit) {
      show(alignFit.alignment);
    }
  }, [alignFit, show]);

  return {
    pins,
    alignDrag,
    setAlignDrag,
    aligning,
    problem: alignFit && 'problem' in alignFit ? alignFit.problem : null,
    errorPx: alignFit && 'alignment' in alignFit ? alignFit.alignment.errorPx : null,
    /** A sensor grabbed - the first one remembers the alignment before, for "Cancel". */
    grab: (drag: PinDrag<'index'>) => {
      if (!aligning) {
        setAlignBefore(alignment);
      }
      setAlignDrag(drag);
    },
    /** The dragged sensor dropped at a fraction of the plan: pinned there (again, if it was). */
    drop: (target: ImagePoint | null) => {
      if (alignDrag && target && onPlanFraction(target)) {
        const pin = { index: alignDrag.index, source: alignDrag.source, target };
        setPins((current) => [...current.filter((existing) => existing.index !== pin.index), pin]);
      }
      setAlignDrag(null);
    },
    /** "Done" keeps the alignment, "Cancel" restores the one before. */
    stop: (restore: boolean) => {
      if (restore && alignBefore) {
        show(alignBefore);
      }
      setAlignBefore(null);
      setPins([]);
      setAlignDrag(null);
    },
  };
};

type PointGroup = { ids: Set<number>; pins: Array<GroupPin & { id: number }> };

/** Group alignment (L): the points (ids), their pins (where a grabbed point is
 * now -> where it belongs, fractions of the image) and the one being dragged
 * (the grabbed point now, the mouse in canvas units). */
export const useGroupAlign = () => {
  const [group, setGroup] = useState<PointGroup | null>(null);
  const [groupDrag, setGroupDrag] = useState<PinDrag<'id'> | null>(null);
  const groupFit = useMemo(() => (group ? fitGroup(group.pins) : null), [group]);
  return {
    group,
    groupDrag,
    setGroupDrag,
    transform: groupFit && 'transform' in groupFit ? groupFit.transform : null,
    problem: groupFit && 'problem' in groupFit ? groupFit.problem : null,
    start: (ids: Set<number>) => setGroup({ ids, pins: [] }),
    leave: () => {
      setGroup(null);
      setGroupDrag(null);
    },
    /** The dragged point dropped at a fraction of the plan: pinned there (again, if it was). */
    drop: (target: ImagePoint | null) => {
      if (groupDrag && target && onPlanFraction(target)) {
        const pin = { id: groupDrag.id, source: groupDrag.source, target };
        setGroup((current) =>
          current ? { ...current, pins: [...current.pins.filter((existing) => existing.id !== pin.id), pin] } : current,
        );
      }
      setGroupDrag(null);
    },
  };
};

/** The scale: the reference point (image pixels) and meters per pixel, from
 * two calibration points of a known distance or typed in. Taken from the
 * plan once: a different plan mounts anew (key), and a stored scale or
 * alignment must not reset what else is being edited. */
export const usePlanScale = (sourceMeta: PlanMeta | undefined) => {
  const [tool, setTool] = useState<CanvasTool>('pan');
  const [referencePoint, setReferencePoint] = useState<ImagePoint | null>(() =>
    sourceMeta?.reference_x != null && sourceMeta.reference_y != null
      ? [sourceMeta.reference_x, sourceMeta.reference_y]
      : null,
  );
  const [calibrationPoints, setCalibrationPoints] = useState<ImagePoint[]>([]);
  const [calibrationMeters, setCalibrationMeters] = useState('');
  const [metersPerPixel, setMetersPerPixel] = useState(() =>
    sourceMeta?.meters_per_pixel ? String(sourceMeta.meters_per_pixel) : '',
  );

  // Two picked points + their real distance -> meters per image pixel.
  const calibrationPixels = calibrationDistance(calibrationPoints);
  useEffect(() => {
    const meters = positiveNumber(calibrationMeters);
    if (calibrationPixels && meters != null) {
      setMetersPerPixel(String(meters / calibrationPixels));
    }
  }, [calibrationPixels, calibrationMeters]);
  const validMetersPerPixel = positiveNumber(metersPerPixel);

  return {
    tool,
    setTool,
    referencePoint,
    calibrationPoints,
    calibrationPixels,
    calibrationMeters,
    setCalibrationMeters,
    metersPerPixel,
    setMetersPerPixel,
    validMetersPerPixel,
    /** The reference point or the ratio differ from the plan's stored ones. */
    differsFrom: (meta: PlanMeta | undefined) =>
      (referencePoint != null && (referencePoint[0] !== meta?.reference_x || referencePoint[1] !== meta?.reference_y)) ||
      (validMetersPerPixel != null && validMetersPerPixel !== (meta?.meters_per_pixel ?? null)),
    /** What "Store scale" stores. */
    values: () => ({
      ...(referencePoint ? { reference_x: referencePoint[0], reference_y: referencePoint[1] } : {}),
      ...(validMetersPerPixel ? { meters_per_pixel: validMetersPerPixel } : {}),
    }),
    /** R / the reference tool: the reference point set, back to panning. */
    setReference: (point: ImagePoint) => {
      setReferencePoint(point);
      setTool('pan');
    },
    /** M: a calibration point picked - a third starts a new measurement. */
    pickCalibration: (point: ImagePoint) => {
      setTool('calibrate');
      setCalibrationPoints((current) => (current.length >= 2 ? [point] : [...current, point]));
    },
    toggleReferenceTool: () => setTool((current) => (current === 'reference' ? 'pan' : 'reference')),
    toggleCalibrateTool: () => {
      setTool((current) => (current === 'calibrate' ? 'pan' : 'calibrate'));
      setCalibrationPoints([]);
    },
    /** The plan moved (crop / rotate): its reference point anew, no calibration points. */
    resetTo: (meta: PlanMeta) => {
      setReferencePoint(meta.reference_x != null && meta.reference_y != null ? [meta.reference_x, meta.reference_y] : null);
      setCalibrationPoints([]);
    },
  };
};

/** Image edit (C / X) or a point selection (D / O / L): the mode, the selected
 * area (two corners in image pixels), whether it is being dragged, and the
 * request applying it. */
export const useAreaSelection = () => {
  const [editMode, setEditMode] = useState<SelectMode | null>(null);
  const [selection, setSelection] = useState<[ImagePoint, ImagePoint] | null>(null);
  const [selecting, setSelecting] = useState(false);
  // Set at once on the press: the mouse may move before the next render.
  const selectingRef = useRef(false);
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState('');
  const endSelection = () => {
    selectingRef.current = false;
    setSelecting(false);
  };
  return {
    editMode,
    selection,
    selecting,
    selectingRef,
    editBusy,
    editError,
    leaveEdit: () => {
      setEditMode(null);
      setSelection(null);
      endSelection();
      setEditError('');
    },
    /** C / X: the edit on, or off again (the other key switches it and keeps the selection). */
    toggleEdit: (edit: ImageEdit) => {
      const next = editMode === edit ? null : edit;
      setEditMode(next);
      setEditError('');
      if (!next) {
        setSelection(null);
      }
    },
    /** A press starts a new area for `mode`. */
    startSelection: (mode: SelectMode, point: ImagePoint) => {
      setEditMode(mode);
      setSelection([point, point]);
      selectingRef.current = true;
      setSelecting(true);
      setEditError('');
    },
    /** The mouse moves the area's second corner. */
    extendSelection: (point: ImagePoint) => setSelection((current) => (current ? [current[0], point] : current)),
    endSelection,
    /** A request applying the selection starts / ends / failed. */
    begin: () => {
      setEditBusy(true);
      setEditError('');
    },
    done: () => setEditBusy(false),
    fail: (message: string) => {
      setEditBusy(false);
      setEditError(message);
    },
  };
};

/** The measure points: as stored (in sensor order), as shown (a group being
 * aligned moved), those a point selection (D / O / L) holds and the cut ones -
 * with where I + click would insert them (insertAt). */
export const useCanvasPoints = (input: {
  measurePoints: Array<Record<string, unknown>>;
  cutPoints: Array<Record<string, unknown>>;
  lineSensors: boolean;
  group: PointGroup | null;
  groupTransform: Parameters<typeof shownItemsOf>[2];
  alignment: AlignmentValues;
  image: PlanImage | null;
  editMode: SelectMode | null;
  selection: [ImagePoint, ImagePoint] | null;
  insertAt: ImagePoint | null;
}) => {
  const { measurePoints, cutPoints, group, groupTransform, alignment, image, selection, insertAt } = input;
  const items = useMemo(() => markerItems(measurePoints), [measurePoints]);
  const lineCount = items.filter((item) => item.end).length;
  const cutItems = useMemo(() => cutItemsOf(cutPoints), [cutPoints]);
  const shownItems = useMemo(
    () => shownItemsOf(items, group, groupTransform, alignment, image),
    [items, group, groupTransform, image, alignment],
  );
  const pointSelect = pointSelectOf(input.editMode);
  const selectedItems = useMemo(
    () => selectedItemsOf(pointSelect != null, shownItems, selection, alignment, image),
    [pointSelect, selection, image, shownItems, alignment],
  );
  const insertPlan = useMemo(() => cutPlacedAt(cutItems, insertAt), [insertAt, cutItems]);
  return {
    items,
    lineCount,
    /** smartex dm: the sensors are band lines. */
    lineMode: input.lineSensors || lineCount > 0,
    cutItems,
    shownItems,
    pointSelect,
    selectedItems,
    selectedIds: pointIdsOf(selectedItems),
    /** The selected area in image pixels, once it can be applied. */
    rect: selectionRect(selection),
    /** The cut points with their middle at the mouse (I held). */
    insertPlan,
  };
};