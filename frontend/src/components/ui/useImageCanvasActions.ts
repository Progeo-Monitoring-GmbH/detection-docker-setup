/**
 * What the plan canvas (ImageCanvasStage) stores: the alignment by itself,
 * auto alignment, image edits (clear, crop, rotate), removing / cutting out /
 * inserting measure points, a group alignment and the scale - with the
 * state changes each one brings.
 */
import { useState } from 'react';
import type { AuthContextType } from '../../../hooks/CoreAuthProvider';
import type { AutoAlignState } from './ImageCanvasAlignmentPanel';
import {
  postAlignment,
  postAutoAlign,
  postImageEdit,
  postPlacePoints,
  postRemovePoints,
  type PlanIds,
} from './imageCanvasApi';
import {
  cutPlacedAt,
  storedAlignment,
  type AlignmentValues,
  type CutItem,
  type ImagePoint,
  type MarkerItem,
} from './imageCanvasGeometry';
import type { ImageEdit, PointSelect } from './imageCanvasModes';
import {
  useAlignmentAutoStore,
  type useAreaSelection,
  type useGroupAlign,
  type usePlanScale,
} from './useImageCanvasEdits';

/** The plan the canvas shows, as stored (ImageCanvasStage's sourceMeta). */
export type SourceMeta = {
  offset_x?: number;
  offset_y?: number;
  scale_x?: number;
  scale_y?: number;
  flip_x?: boolean;
  flip_y?: boolean;
  reference_x?: number | null;
  reference_y?: number | null;
  meters_per_pixel?: number | null;
};

export type PlanScaleValues = {
  reference_x?: number;
  reference_y?: number;
  meters_per_pixel?: number;
};

type Answer = Record<string, unknown>;

type ImageCanvasActionsInput = {
  auth: AuthContextType;
  locationId?: number;
  lageplanId?: number;
  sourceMeta?: SourceMeta;
  withSliders: boolean;
  alignment: AlignmentValues;
  showAlignment: (values: AlignmentValues) => void;
  area: ReturnType<typeof useAreaSelection>;
  scale: ReturnType<typeof usePlanScale>;
  groupAlign: ReturnType<typeof useGroupAlign>;
  /** The selected measure points (D / O / L), their ids, what they are for, the area. */
  selected: {
    items: Set<MarkerItem>;
    ids: number[];
    pointSelect: PointSelect | null;
    rect: { x: number; y: number; width: number; height: number } | null;
  };
  shownItems: MarkerItem[];
  cutItems: CutItem[];
  /** The plan image moved (crop / rotate): no frame of the old one, the view anew. */
  dropImage: () => void;
  resetView: () => void;
  clearHover: () => void;
  clearInsert: () => void;
  onSaveSliders?: (values: AlignmentValues) => void;
  onSaveScale?: (values: PlanScaleValues) => void;
  onImageEdited?: (response: Answer) => void;
  onPointsRemoved?: (response: Answer) => void;
  onCut?: (points: Array<Record<string, unknown>>) => void;
  onPointsPlaced?: (response: Answer, action: 'insert' | 'align') => void;
};

export const useImageCanvasActions = (input: ImageCanvasActionsInput) => {
  const { auth, locationId, lageplanId, alignment, area, scale, groupAlign, selected } = input;
  const [autoAlign, setAutoAlign] = useState<AutoAlignState>(null);

  const planIds = (): PlanIds | null =>
    locationId != null && lageplanId != null ? { locationId, lageplanId } : null;

  const autoStore = useAlignmentAutoStore(
    input.withSliders,
    alignment,
    storedAlignment(input.sourceMeta, true),
    (values) =>
      input.onSaveSliders ? input.onSaveSliders(values) : postAlignment(auth, { locationId, lageplanId }, values),
  );

  // Auto alignment: the backend fits the points onto the plan's orange lines
  // (dm bands / sensors of the CAD drawing), starting from what is shown.
  const runAutoAlign = () => {
    const before = alignment;
    setAutoAlign({ busy: true });
    postAutoAlign(
      auth,
      { locationId, lageplanId },
      before,
      (values, score, matched) => {
        input.showAlignment(values);
        setAutoAlign({ busy: false, score, matched, before });
      },
      (error) => setAutoAlign({ busy: false, error }),
    );
  };

  /** A crop / rotation moved the plan: the points keep their place on it -
   * their alignment, the reference point (image pixels) and the view start anew. */
  const takeMovedPlan = (answer: Answer, values: AlignmentValues) => {
    const plan = (answer.lageplan ?? {}) as SourceMeta;
    const moved = storedAlignment(plan, values.flipY);
    autoStore.markStored(moved);
    input.showAlignment(moved);
    scale.resetTo(plan);
    input.dropImage();
    input.resetView();
  };

  /** An image edit (measure_points/edit_lageplan) with the alignment shown;
   * the new image is loaded in place. */
  const editImage = (action: ImageEdit | 'rotate', extra: Record<string, unknown>) => {
    const ids = planIds();
    if (!ids) {
      return;
    }
    const values = alignment;
    // Stored with the edit: a store still pending must not follow it.
    autoStore.markStored(values);
    autoStore.dropPending();
    area.begin();
    postImageEdit(
      auth,
      ids,
      action,
      extra,
      values,
      (answer) => {
        area.done();
        area.leaveEdit();
        if (action === 'crop' || action === 'rotate') {
          takeMovedPlan(answer, values);
        }
        input.onImageEdited?.(answer);
      },
      area.fail,
    );
  };

  /** "Remove": the server deletes the selected measure points; the caller
   * drops them from what it shows (onPointsRemoved). */
  const removePoints = () => {
    if (!selected.ids.length || locationId == null) {
      return;
    }
    area.begin();
    postRemovePoints(
      auth,
      locationId,
      selected.ids,
      (answer) => {
        area.done();
        area.leaveEdit();
        input.clearHover();
        input.onPointsRemoved?.(answer);
      },
      area.fail,
    );
  };

  /** "Cut": the selected points go to the caller's clipboard (onCut) -
   * nothing is stored before they are inserted (I + click). */
  const cutSelected = () => {
    const points = [...selected.items].map((item) => item.point).filter((point) => Number.isInteger(Number(point.id)));
    if (!points.length) {
      return;
    }
    area.leaveEdit();
    input.clearHover();
    input.onCut?.(points);
  };

  /** "Align N": the selected points are aligned by themselves (L) - drag
   * them onto their place, then "Apply". */
  const startGroup = () => {
    if (!selected.ids.length) {
      return;
    }
    const ids = new Set(selected.ids);
    area.leaveEdit();
    groupAlign.start(ids);
  };

  /** Moves points onto this plan at new normalized positions (measure_points/place). */
  const placePoints = (positions: CutItem[], action: 'insert' | 'align', onDone: () => void) => {
    const ids = planIds();
    if (!ids) {
      return;
    }
    area.begin();
    postPlacePoints(
      auth,
      ids,
      positions,
      action,
      (answer) => {
        area.done();
        input.clearHover();
        onDone();
        input.onPointsPlaced?.(answer, action);
      },
      area.fail,
    );
  };

  return {
    autoAlign,
    runAutoAlign,
    /** Undo of the auto alignment: the alignment before it. */
    undoAutoAlign: (before: AlignmentValues) => {
      input.showAlignment(before);
      setAutoAlign(null);
    },
    closeAutoAlign: () => setAutoAlign(null),

    /** Rotation by 90 degrees: the server turns the image and the plan's
     * measure points with it - they stay on the drawing. */
    rotateImage: (clockwise: boolean) => editImage('rotate', { direction: clockwise ? 'cw' : 'ccw' }),

    /** "Apply": removes / cuts out / groups the selected points, or clears /
     * crops the image (a crop moves the alignment onto the cropped image). */
    applyEdit: () => {
      const pointActions: Record<PointSelect, () => void> = { remove: removePoints, cut: cutSelected, group: startGroup };
      if (selected.pointSelect) {
        pointActions[selected.pointSelect]();
        return;
      }
      if (area.editMode && selected.rect) {
        editImage(area.editMode as ImageEdit, { ...selected.rect });
      }
    },

    /** I + click: the cut points onto this plan, their middle at the click. */
    insertCut: (at: ImagePoint) => {
      const placed = cutPlacedAt(input.cutItems, at);
      if (placed) {
        placePoints(placed, 'insert', input.clearInsert);
      }
    },

    /** Group "Apply": the group's points where the pins put them. */
    storeGroup: () => {
      const { group } = groupAlign;
      if (!group || !groupAlign.transform) {
        return;
      }
      placePoints(
        input.shownItems
          .filter((item) => group.ids.has(Number(item.point.id)))
          .map((item) => ({ id: Number(item.point.id), start: item.start, end: item.end })),
        'align',
        groupAlign.leave,
      );
    },

    /** "Store scale": the reference point and meters per pixel, back to panning. */
    storeScale: () => {
      if (!input.onSaveScale) {
        return;
      }
      const values: PlanScaleValues = scale.values();
      scale.setTool('pan');
      input.onSaveScale(values);
    },
  };
};
