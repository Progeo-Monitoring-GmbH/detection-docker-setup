import { useMemo, useRef, useState, type CSSProperties } from 'react';
import { useAuth } from '../../../hooks/CoreAuthProvider';
import { childTestId } from '../../testIds';
import ZoomControls from '../device/ZoomControls';
import { ALIGN_PINS } from './alignmentFit';
import CanvasKeyLegend from './CanvasKeyLegend';
import { AlignBar, ApplyBar, GroupBar, ScaleBar } from './ImageCanvasActionBars';
import { AlignmentPanel } from './ImageCanvasAlignmentPanel';
import {
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  compactCanvasWidth,
  itemsImageArea,
  MIN_ZOOM,
  stageGeometry,
  viewForImageArea,
  ZOOM_STEP,
  type AlignmentValues,
  type ImagePoint,
} from './imageCanvasGeometry';
import { canvasLegendGroups, repairLegendGroups } from './imageCanvasLegend';
import { repairItems, type RepairOverlay } from './drawSensorRepair';
import { LINE_SNAP, REPAIR_COLOR } from './sensorOrderRepair';
import SensorRepairPanel, { repairHint } from './SensorRepairPanel';
import { useSensorOrderRepair } from './useSensorOrderRepair';
import {
  alignHint,
  applyModeOf,
  canvasBadge,
  canvasCaps,
  canvasCursor,
  editingOf,
  groupSummary,
  insertingOf,
  VIEW_KEYS,
  type CanvasModes,
  type SensorPlacement,
} from './imageCanvasModes';
import { CanvasBadge, CanvasTooltip, RotateButtons } from './ImageCanvasOverlays';
import { CanvasError, CanvasFooter, CutPanel, GroupPanel, NoLinesWarning, StageHeader } from './ImageCanvasPanels';
import { ScalePanel } from './ImageCanvasScalePanel';
import { useCanvasPointer, type BandEndDrag, type Hover } from './useCanvasPointer';
import { useImageCanvasActions, type PlanScaleValues, type SourceMeta } from './useImageCanvasActions';
import {
  useAreaSelection,
  useCanvasPoints,
  useGroupAlign,
  usePlanScale,
  usePointAlignment,
  usePointCalibration,
} from './useImageCanvasEdits';
import {
  useCanvasWheelZoom,
  useHeldKey,
  usePlanImage,
  usePlanView,
  useScreenScale,
  useStageDrawing,
} from './useImageCanvasView';
import { WheelZoomHint } from './wheelZoom';
import './ImageCanvasStage.css';

// Used by the heatmaps and zone overlays to place points as the canvas does.
export { alignmentBaseScale, normalizedToImage } from './imageCanvasGeometry';
export type { PlacedSensor } from './imageCanvasModes';
export type { PlanScaleValues } from './useImageCanvasActions';

type ImageCanvasStageProps = {
  imageUrl?: string;
  locationId?: number;
  /** The Lageplan shown - the flip toggle stores onto it (else the active one). */
  lageplanId?: number;
  sourceMeta?: SourceMeta;
  title?: string;
  fileName?: string;
  measurePoints?: Array<Record<string, unknown>>;
  /** smartex dm: the sensors are band lines from nx/ny to nx_end/ny_end. */
  lineSensors?: boolean;
  /** Names of the devices points are connected to (tooltip), by id. */
  deviceLabels?: Record<number, string>;
  /** sensor_order of each device's pair 1 (ProgeoDevice.first_sensor_order), by id. */
  devicePairStarts?: Record<number, number>;
  withSliders?: boolean;
  /** Stores the alignment - called by itself shortly after it changed. */
  onSaveSliders?: (values: AlignmentValues) => void;
  /** Stores the metric scale (reference point in image pixels, m/px). */
  onSaveScale?: (values: PlanScaleValues) => void;
  placement?: SensorPlacement;
  /** Enables clearing (C) and cropping (X) the plan image, done on the server
   * (measure_points/edit_lageplan) - called with its answer, which carries
   * the stored plan ("lageplan": new url, a crop's moved alignment). */
  onImageEdited?: (response: Record<string, unknown>) => void;
  /** Enables removing measure points (hold D, drag over them, "Remove"),
   * done on the server (measure_points/remove) - called with its answer,
   * which lists the removed ids ("point_ids"). */
  onPointsRemoved?: (response: Record<string, unknown>) => void;
  /** Measure points cut out (O + drag) - kept by the caller, on any plan, until
   * inserted (I + click) or discarded. */
  cutPoints?: Array<Record<string, unknown>>;
  /** Enables cutting out (O + drag, "Cut"): the selected points' records - the
   * caller keeps them and leaves them out of measurePoints. Nothing is stored. */
  onCut?: (points: Array<Record<string, unknown>>) => void;
  onDiscardCut?: () => void;
  /** Enables inserting the cut points (I + click) and aligning a group of
   * points (L + drag), stored on the server (measure_points/place) - called
   * with its answer, which carries the moved points ("points"). */
  onPointsPlaced?: (response: Record<string, unknown>, action: 'insert' | 'align') => void;
  /** Enables "Repair order" (numbering points again by hand), stored on the
   * server (measure_points/reorder) - called with its answer, which carries
   * the points whose dot changed ("points"). */
  onPointsReordered?: (response: Record<string, unknown>) => void;
  /** data-testid of the stage; its parts are "<testId>-canvas", "-zoom", "-apply", "-scale-store", ... */
  testId?: string;
};

/**
 * The Lageplan canvas: the plan with its measure points (or sensors placed by
 * hand), pan and zoom (F fits the selection, the plan or an area; the frame
 * glows in the colour of the key in use), and - with the sliders - aligning the points (sliders,
 * A, auto), the scale (R, M), image edits (C, X, rotate) and editing the
 * measure points (D, O, I, L).
 *
 * The parts: imageCanvasGeometry (coordinates, hit tests), imageCanvasModes
 * (what is possible, badge, cursor, texts), imageCanvasLegend,
 * drawImageCanvas, imageCanvasApi (server calls), the hooks useImageCanvasView
 * (image, pan / zoom, keys, drawing), useImageCanvasEdits (alignment, pins,
 * scale, selection), useCanvasPointer (the mouse), useImageCanvasActions
 * (what is stored) and the ImageCanvas* panels, overlays and bars.
 */
const ImageCanvasStage = ({
  imageUrl,
  sourceMeta,
  title = 'Image preview',
  fileName,
  measurePoints = [],
  lineSensors = false,
  deviceLabels,
  devicePairStarts,
  withSliders = false,
  locationId,
  lageplanId,
  onSaveSliders,
  onSaveScale,
  placement,
  onImageEdited,
  onPointsRemoved,
  cutPoints = [],
  onCut,
  onDiscardCut,
  onPointsPlaced,
  onPointsReordered,
  testId = 'image-canvas',
}: ImageCanvasStageProps) => {
  const auth = useAuth();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const { image, setImage, imageError } = usePlanImage(auth, imageUrl);
  const point = usePointAlignment(sourceMeta);
  const { alignment } = point;
  const scale = usePlanScale(sourceMeta);
  const area = useAreaSelection();
  const calibration = usePointCalibration(image, alignment, point.show);
  const { aligning } = calibration;
  const groupAlign = useGroupAlign();
  const { group } = groupAlign;
  // The sensor under the mouse (index into items) and the mouse position
  // over the canvas in CSS pixels, for its tooltip.
  const [hover, setHover] = useState<Hover | null>(null);
  // Insert (I held): the normalized point under the mouse - the cut points' middle goes there.
  const [insertAt, setInsertAt] = useState<ImagePoint | null>(null);

  // Compact: left-aligned, at the screen scale and height of the full width,
  // so a tall plan has no empty bands beside it. Its units stay the
  // alignment's (CANVAS_HEIGHT high): the plan's scale depends on the image
  // only, the points' place is relative to the drawn plan.
  const canvasWidth = compactCanvasWidth(image);
  const logical = useMemo(() => ({ width: canvasWidth, height: CANVAS_HEIGHT }), [canvasWidth]);
  const { cssWidth, cssHeight, screenScale, px, pixelRatio } = useScreenScale(canvasRef, canvasWidth);
  const { view, zoomAround, resetView, panTo, endPan, glideTo } = usePlanView(logical, image);
  const wheelHint = useCanvasWheelZoom(canvasRef, zoomAround);
  // The keys count while the mouse is over the canvas (and what floats on it).
  const overRef = useRef(false);
  // F + drag: the area being dragged; fitDragged: F was used with a drag (no fit on its release).
  const [fitBox, setFitBox] = useState<[ImagePoint, ImagePoint] | null>(null);
  const fitDragged = useRef(false);
  // E + drag: the dm band end being moved (shown there until it is stored).
  const [bandEndDrag, setBandEndDrag] = useState<BandEndDrag | null>(null);

  const { items, lineCount, lineMode, cutItems, shownItems, pointSelect, selectedItems, selectedIds, rect, insertPlan } =
    useCanvasPoints({
      measurePoints,
      cutPoints,
      lineSensors,
      group,
      groupTransform: groupAlign.transform,
      alignment,
      image,
      editMode: area.editMode,
      selection: area.selection,
      insertAt,
    });
  const caps = canvasCaps({
    withSliders,
    placing: placement != null,
    hasImage: image != null,
    itemCount: items.length,
    cutCount: cutItems.length,
    alignPins: ALIGN_PINS,
    locationId,
    lageplanId,
    onSaveScale,
    onImageEdited,
    onPointsRemoved,
    onCut,
    onPointsPlaced,
    lineMode,
  });


  const geometry = stageGeometry(logical, image, view, alignment);
  // "Repair order": numbering points again by hand - while on, the keys and the mouse are its own.
  const canRepair =
    withSliders && image != null && !placement && locationId != null && onPointsReordered != null && items.length > 1;
  const repair = useSensorOrderRepair({
    auth,
    locationId,
    items,
    shownItems,
    alignment,
    image,
    transform: geometry.transform,
    px,
    onStored: onPointsReordered,
  });
  const repairing = canRepair && repair.active;

  /** F: the selected points (D / O / L), the selected area (C / X), the
   * group being aligned - else the whole plan - as large as it fits. */
  const fitSelection = () => {
    const { transform } = geometry;
    if (!image || !transform) {
      return;
    }
    const groupItems = group ? shownItems.filter((item) => group.ids.has(Number(item.point.id))) : [];
    const target =
      itemsImageArea(selectedItems, transform, image) ??
      (area.selection && area.editMode ? area.selection : null) ??
      itemsImageArea(groupItems, transform, image);
    glideTo(target ? viewForImageArea(target, logical, image) : { zoom: 1, offsetX: 0, offsetY: 0 });
  };
  /** F + drag let go: zoom to the area - a mere click fits the selection. */
  const fitBoxDone = ([from, to]: [ImagePoint, ImagePoint]) => {
    fitDragged.current = true;
    const { layout } = geometry;
    if (!image || !layout) {
      return;
    }
    const minSize = 8 * px;
    if (Math.abs(to[0] - from[0]) < minSize || Math.abs(to[1] - from[1]) < minSize) {
      fitSelection();
      return;
    }
    const toImage = ([x, y]: ImagePoint): ImagePoint => [(x - layout.drawX) / layout.scale, (y - layout.drawY) / layout.scale];
    glideTo(viewForImageArea([toImage(from), toImage(to)], logical, image, 8));
  };

  const heldKey = useHeldKey({
    onEscape: () => {
      area.leaveEdit();
      groupAlign.leave();
    },
    // Clearing / cropping the image, not during the point calibration.
    onEditKey: (edit) => {
      if (caps.canEditImage && !aligning) {
        area.toggleEdit(edit);
      }
    },
    // F tapped (no drag while held): fit the selection or the plan.
    onRelease: (key) => {
      if (key === 'f' && !fitDragged.current) {
        fitSelection();
      }
      fitDragged.current = false;
    },
    isOver: () => overRef.current,
    disabled: repairing,
  });
  const modes: CanvasModes = {
    caps,
    heldKey,
    tool: scale.tool,
    editMode: area.editMode,
    hasSelection: rect != null,
    selecting: area.selecting,
    selectedCount: selectedIds.length,
    cutCount: cutItems.length,
    group: groupSummary(group),
    aligning,
    lineMode,
    calibrationCount: scale.calibrationPoints.length,
  };

  const { result: repairResult, preview: repairPreview, klemmliste, verdicts, lineStart, mouse, swapFirst, areaDrag } = repair;
  // A band end being dragged (E) is drawn where the mouse is.
  const movedItems = useMemo(
    () =>
      bandEndDrag
        ? shownItems.map((item, index) =>
            index === bandEndDrag.index ? { ...item, [bandEndDrag.which]: bandEndDrag.at } : item,
          )
        : shownItems,
    [shownItems, bandEndDrag],
  );
  const drawnItems = useMemo(
    () => (repairing ? repairItems(movedItems, repairResult, repairPreview, klemmliste) : movedItems),
    [repairing, movedItems, repairResult, repairPreview, klemmliste],
  );
  const repairOverlay = useMemo<RepairOverlay | null>(() => {
    if (!repairing) {
      return null;
    }
    const byId = new Map(shownItems.map((item) => [Number(item.point.id), item]));
    const startOf = (id: number) => byId.get(id)?.start ?? null;
    const swapItem = swapFirst != null ? byId.get(swapFirst) : undefined;
    return {
      boxes: repairResult.boxes,
      drag: areaDrag ? { box: [areaDrag.from, areaDrag.to], remove: areaDrag.op === 'remove' } : null,
      line: lineStart ? { from: lineStart, to: mouse } : null,
      lines: repairResult.lines.flatMap((ids, index) => {
        const [from, to] = [startOf(ids[0]), startOf(ids[ids.length - 1])];
        return from && to ? [{ from, to, ok: verdicts[index]?.ok ?? null }] : [];
      }),
      verdict: repair.previewVerdict,
      swapFirst: swapItem?.start ?? null,
      snap: LINE_SNAP,
    };
  }, [repairing, shownItems, repairResult, areaDrag, lineStart, mouse, verdicts, repair.previewVerdict, swapFirst]);

  useStageDrawing(canvasRef, {
    image,
    logical,
    pixelRatio,
    px,
    view,
    alignment,
    editMode: area.editMode,
    selection: area.selection,
    selectedItems,
    placement,
    items: drawnItems,
    repair: repairOverlay,
    hoveredIndex: hover?.index ?? null,
    lineMode,
    group,
    groupDrag: groupAlign.groupDrag,
    insertGhost: insertingOf(modes) ? insertPlan : null,
    pins: calibration.pins,
    alignDrag: calibration.alignDrag,
    calibrationPoints: scale.calibrationPoints,
    referencePoint: scale.referencePoint,
    fitBox,
  });

  const actions = useImageCanvasActions({
    auth,
    locationId,
    lageplanId,
    sourceMeta,
    withSliders,
    alignment,
    showAlignment: point.show,
    area,
    scale,
    groupAlign,
    selected: { items: selectedItems, ids: selectedIds, pointSelect, rect },
    shownItems,
    cutItems,
    dropImage: () => setImage(null),
    resetView,
    clearHover: () => setHover(null),
    clearInsert: () => setInsertAt(null),
    onSaveSliders,
    onSaveScale,
    onImageEdited,
    onPointsRemoved,
    onCut,
    onPointsPlaced,
  });

  const pointer = useCanvasPointer({
    canvasRef,
    modes,
    placement,
    image,
    ...geometry,
    alignment,
    view,
    px,
    screenScale,
    panTo,
    endPan,
    fit: { setBox: setFitBox, onDone: fitBoxDone },
    items,
    shownItems,
    area,
    calibration,
    groupAlign,
    scale,
    setHover,
    setInsertAt,
    insertCut: actions.insertCut,
    repair: repairing ? repair : undefined,
    bandEnd: {
      drag: bandEndDrag,
      setDrag: setBandEndDrag,
      drop: (drag) => {
        const item = items[drag.index];
        setBandEndDrag(null);
        if (item?.end) {
          actions.moveBandEnd({
            id: Number(item.point.id),
            start: drag.which === 'start' ? drag.at : item.start,
            end: drag.which === 'end' ? drag.at : item.end,
          });
        }
      },
    },
  });
  const startRepair = () => {
    area.leaveEdit();
    groupAlign.leave();
    repair.start();
  };

  const hoveredItem = hover ? (items[hover.index] ?? null) : null;
  // The reference point or the ratio differ from the plan's stored ones -
  // "Store scale" floats until they are stored.
  const scaleDirty = withSliders && onSaveScale != null && scale.differsFrom(sourceMeta);
  const viewKeyHeld = heldKey != null && VIEW_KEYS.includes(heldKey);
  const cursor = repairing && !viewKeyHeld
    ? repair.tool === 'area' || repair.tool === 'line'
      ? 'crosshair'
      : hoveredItem
        ? 'pointer'
        : 'grab'
    : canvasCursor(modes, {
        placing: placement?.activeDeviceId != null,
        dragging: pointer.dragging,
        hovered: hoveredItem,
        groupIds: group?.ids ?? null,
      });

  // What is going on - the badge on the plan, the frame glows in its colour.
  // F and Space are shown in "Repair order" too.
  const badge = repairing && !viewKeyHeld ? { text: repairHint(repair), color: REPAIR_COLOR } : canvasBadge(modes);

  return (
    <div className="d-flex flex-column gap-3" data-testid={testId}>
      <StageHeader title={title} fileName={fileName} testId={testId} />

      <CanvasKeyLegend
        testId={childTestId(testId, 'legend')}
        groups={repairing ? repairLegendGroups(repair.tool, heldKey) : canvasLegendGroups(modes, placement)}
      />

      <div className="d-flex flex-column gap-2">
        {/* As wide as the compact canvas (its share of the full width), left-aligned. */}
        <div
          className={`image-canvas-wrap${badge ? ' image-canvas-wrap--keyed' : ''}`}
          style={{
            width: `${(canvasWidth / CANVAS_WIDTH) * 100}%`,
            ...(badge ? { '--image-canvas-key-color': badge.color } : {}),
          } as CSSProperties}
          onMouseEnter={() => {
            overRef.current = true;
          }}
          onMouseLeave={() => {
            overRef.current = false;
          }}
          data-key-color={badge?.color}
        >
          <canvas
            ref={canvasRef}
            width={Math.round(canvasWidth * pixelRatio)}
            height={Math.round(CANVAS_HEIGHT * pixelRatio)}
            onMouseDown={pointer.onMouseDown}
            onMouseUp={pointer.onMouseUp}
            onMouseMove={pointer.onMouseMove}
            onMouseLeave={pointer.onMouseLeave}
            onClick={pointer.onClick}
            className={`image-canvas-stage-canvas image-canvas-stage-canvas--${cursor}`}
            style={{ aspectRatio: `${canvasWidth} / ${CANVAS_HEIGHT}` }}
            data-testid={childTestId(testId, 'canvas')}
          />
          <ZoomControls
            onZoomIn={() => zoomAround(ZOOM_STEP)}
            onZoomOut={() => zoomAround(1 / ZOOM_STEP)}
            onReset={resetView}
            zoomOutDisabled={view.zoom <= MIN_ZOOM}
            resetDisabled={view.zoom === 1 && view.offsetX === 0 && view.offsetY === 0}
            testId={childTestId(testId, 'zoom')}
          />
          <WheelZoomHint visible={wheelHint} testId={childTestId(testId, 'wheel-hint')} />
          <RotateButtons
            shown={caps.canEditImage && !editingOf(modes) && !repairing}
            disabled={area.editBusy || aligning}
            onRotate={actions.rotateImage}
            testId={testId}
          />
          <CanvasBadge badge={badge} testId={testId} />
          <CanvasTooltip
            hover={hover}
            item={hoveredItem}
            info={{ deviceLabels, devicePairStarts, image, metersPerPixel: scale.validMetersPerPixel, alignment, lineMode }}
            cssWidth={cssWidth}
            cssHeight={cssHeight}
            testId={testId}
          />
        </div>

        <CanvasFooter
          zoom={view.zoom}
          items={items}
          lineMode={lineMode}
          lineCount={lineCount}
          placing={placement != null}
          testId={testId}
        />

        <NoLinesWarning
          placing={placement != null}
          lineSensors={lineSensors}
          itemCount={items.length}
          lineCount={lineCount}
          testId={testId}
        />
      </div>

      <SensorRepairPanel repair={{ ...repair, start: startRepair }} canRepair={canRepair} testId={testId} />

      <GroupPanel group={modes.group} problem={groupAlign.problem} lineMode={lineMode} testId={testId} />

      <CutPanel
        count={cutItems.length}
        canInsert={caps.canInsert}
        lineMode={lineMode}
        busy={area.editBusy}
        onDiscard={onDiscardCut}
        testId={testId}
      />

      <CanvasError message={area.editError} alert testId={childTestId(testId, 'edit-error')} />
      <CanvasError message={imageError} testId={childTestId(testId, 'image-error')} />

      {withSliders && (
        <AlignmentPanel
          alignment={alignment}
          setters={point}
          onToggleFlip={() => point.setFlipY((current) => !current)}
          canAutoAlign={caps.canAutoAlign}
          autoAlign={actions.autoAlign}
          onAutoAlign={actions.runAutoAlign}
          onUndoAutoAlign={actions.undoAutoAlign}
          onCloseAutoAlign={actions.closeAutoAlign}
          canAlign={caps.canAlign}
          aligning={aligning}
          pins={calibration.pins.length}
          alignHintText={alignHint(calibration.pins.length, ALIGN_PINS, calibration.problem, calibration.errorPx, lineMode)}
          lineMode={lineMode}
          testId={testId}
        />
      )}

      {withSliders && onSaveScale && (
        <ScalePanel
          tool={scale.tool}
          referencePoint={scale.referencePoint}
          onToggleReference={scale.toggleReferenceTool}
          calibrationCount={scale.calibrationPoints.length}
          calibrationPixels={scale.calibrationPixels}
          calibrationMeters={scale.calibrationMeters}
          onCalibrationMeters={scale.setCalibrationMeters}
          onToggleCalibrate={scale.toggleCalibrateTool}
          metersPerPixel={scale.metersPerPixel}
          onMetersPerPixel={scale.setMetersPerPixel}
          dirty={scaleDirty}
          testId={testId}
        />
      )}

      <ApplyBar
        mode={applyModeOf(modes)}
        selectedCount={selectedIds.length}
        lineMode={lineMode}
        busy={area.editBusy}
        onCancel={area.leaveEdit}
        onApply={actions.applyEdit}
        testId={testId}
      />

      <AlignBar
        aligning={aligning}
        pins={calibration.pins.length}
        lineMode={lineMode}
        onStop={calibration.stop}
        testId={testId}
      />

      <GroupBar
        group={modes.group}
        fits={groupAlign.transform != null}
        lineMode={lineMode}
        busy={area.editBusy}
        onCancel={groupAlign.leave}
        onApply={actions.storeGroup}
        testId={testId}
      />

      <ScaleBar
        dirty={scaleDirty}
        hasReference={scale.referencePoint != null}
        metersPerPixel={scale.validMetersPerPixel}
        onStore={actions.storeScale}
        testId={testId}
      />
    </div>
  );
};

export default ImageCanvasStage;
