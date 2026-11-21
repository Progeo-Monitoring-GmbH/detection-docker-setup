/**
 * Draws the plan canvas of ImageCanvasStage: the plan, a selected area, the
 * sensors (placed by hand or measure points), the marks of the running
 * action (selection, group, insert, pins) and the scale's points. Sizes are
 * screen pixels (px canvas units each) at any zoom.
 */
import { canvasFont } from '../../styles/fonts';
import type { AlignPin } from './alignmentFit';
import type { GroupPin } from './groupAlign';
import {
  canvasLayout,
  fractionToCanvas,
  imageToCanvas,
  LABEL_SPACING,
  normalizedToCanvas,
  pointTransform,
  SENSOR_RADIUS,
  type AlignmentValues,
  type CanvasLayout,
  type CutItem,
  type ImagePoint,
  type MarkerItem,
  type PlanView,
  type PointTransform,
} from './imageCanvasGeometry';
import { CUT_COLOR, GROUP_COLOR, PRIMARY_COLOR, pointSelectOf, selectColorOf, type SelectMode } from './imageCanvasModes';

/** A point being dragged onto its place: the grabbed point and the mouse (canvas units). */
export type PinDrag<K extends string> = { [key in K]: number } & { source: ImagePoint; at: ImagePoint };

export type StageScene = {
  image: CanvasImageSource & { naturalWidth: number; naturalHeight: number };
  logical: { width: number; height: number };
  pixelRatio: number;
  /** Canvas units per screen pixel. */
  px: number;
  view: PlanView;
  alignment: AlignmentValues;
  editMode: SelectMode | null;
  selection: [ImagePoint, ImagePoint] | null;
  selectedItems: Set<MarkerItem>;
  placement?: { sensors: Array<{ deviceId: number; label: string; nx: number; ny: number }>; activeDeviceId: number | null };
  /** The measure points as shown (a group being aligned where its pins put it). */
  items: MarkerItem[];
  hoveredIndex: number | null;
  lineMode: boolean;
  group: { ids: Set<number>; pins: Array<GroupPin & { id: number }> } | null;
  groupDrag: PinDrag<'id'> | null;
  insertGhost: CutItem[] | null;
  pins: Array<AlignPin & { index: number }>;
  alignDrag: PinDrag<'index'> | null;
  calibrationPoints: ImagePoint[];
  referencePoint: ImagePoint | null;
};

type Positioned = { item: MarkerItem; start: ImagePoint; end: ImagePoint | null };

const FULL_CIRCLE = Math.PI * 2;

/** Drawing helpers at a screen pixel size. */
const pen = (ctx: CanvasRenderingContext2D, px: number) => {
  const line = (from: ImagePoint, to: ImagePoint) => {
    ctx.beginPath();
    ctx.moveTo(from[0], from[1]);
    ctx.lineTo(to[0], to[1]);
  };
  const circle = ([x, y]: ImagePoint, radius: number) => {
    ctx.beginPath();
    ctx.arc(x, y, radius * px, 0, FULL_CIRCLE);
  };
  const cross = ([x, y]: ImagePoint, arm: number) => {
    ctx.beginPath();
    ctx.moveTo(x - arm * px, y);
    ctx.lineTo(x + arm * px, y);
    ctx.moveTo(x, y - arm * px);
    ctx.lineTo(x, y + arm * px);
  };
  /** Text with a white halo, readable on any plan. */
  const label = (text: string, x: number, y: number, color: string, size = 11) => {
    ctx.font = canvasFont(600, size * px);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3.5 * px;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  };
  // Pins (A, L): the dashed line from a point to where it is dragged /
  // pinned, and a pin's numbered crosshair.
  const pinLine = (from: ImagePoint, to: ImagePoint, color: string) => {
    line(from, to);
    ctx.setLineDash([5 * px, 4 * px]);
    ctx.lineWidth = 2 * px;
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.setLineDash([]);
  };
  const pinMark = (target: ImagePoint, number: number, color: string) => {
    cross(target, 10);
    ctx.lineWidth = 2.5 * px;
    ctx.strokeStyle = color;
    ctx.stroke();
    label(String(number + 1), target[0] + 8 * px, target[1] - 10 * px, color, 13);
  };
  return { ctx, px, line, circle, cross, label, pinLine, pinMark };
};

type Pen = ReturnType<typeof pen>;

/** Image edit: the selected area - white as "clear" will leave it, or the
 * rest of the plan dimmed for "crop"; a point selection tinted. */
const drawSelectionArea = ({ ctx, px }: Pen, scene: StageScene, layout: CanvasLayout) => {
  const { editMode, selection } = scene;
  if (!editMode || !selection) {
    return;
  }
  const [[ax, ay], [bx, by]] = selection.map((point) => imageToCanvas(point, layout));
  const [left, top, right, bottom] = [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)];
  const selectColor = selectColorOf(editMode);
  if (editMode === 'crop') {
    ctx.beginPath();
    ctx.rect(layout.drawX, layout.drawY, layout.drawWidth, layout.drawHeight);
    ctx.rect(left, top, right - left, bottom - top);
    ctx.fillStyle = 'rgba(16, 20, 25, 0.45)';
    ctx.fill('evenodd');
  } else if (pointSelectOf(editMode)) {
    ctx.save();
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = selectColor;
    ctx.fillRect(left, top, right - left, bottom - top);
    ctx.restore();
  } else {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(left, top, right - left, bottom - top);
  }
  ctx.setLineDash([6 * px, 4 * px]);
  ctx.lineWidth = 1.5 * px;
  ctx.strokeStyle = editMode === 'crop' ? PRIMARY_COLOR : selectColor;
  ctx.strokeRect(left, top, right - left, bottom - top);
  ctx.setLineDash([]);
};

/** Sensors placed by hand: numbered dots with their label (MAC) beside. */
const drawPlacedSensors = (p: Pen, scene: StageScene, transform: PointTransform) => {
  const { ctx, px } = p;
  const { placement } = scene;
  placement?.sensors.forEach((sensor, index) => {
    const point = normalizedToCanvas([sensor.nx, sensor.ny], transform);
    const active = sensor.deviceId === placement.activeDeviceId;

    p.circle(point, SENSOR_RADIUS);
    ctx.fillStyle = active ? PRIMARY_COLOR : '#198754';
    ctx.fill();
    ctx.lineWidth = (active ? 3 : 2) * px;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();

    ctx.font = canvasFont(600, 11 * px);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(String(index + 1), point[0], point[1]);

    p.label(sensor.label, point[0] + (SENSOR_RADIUS + 4) * px, point[1], active ? PRIMARY_COLOR : '#212529', 12);
  });
};

/** A measure point: its band line (smartex dm) or a dot - dashed for a dm
 * sensor without its band. */
const drawMarker = (p: Pen, { item, start, end }: Positioned, active: boolean, lineMode: boolean) => {
  const { ctx, px } = p;
  if (end) {
    ctx.lineCap = 'round';
    p.line(start, end);
    ctx.lineWidth = (active ? 9 : 5.5) * px;
    ctx.strokeStyle = active ? '#101419' : 'rgba(255, 255, 255, 0.85)';
    ctx.stroke();
    ctx.lineWidth = (active ? 5.5 : 3) * px;
    ctx.strokeStyle = item.color;
    ctx.stroke();
    return;
  }
  p.circle(start, active ? 8.5 : 6.5);
  ctx.fillStyle = item.color;
  ctx.fill();
  ctx.lineWidth = (active ? 3 : 2) * px;
  ctx.strokeStyle = active ? '#101419' : '#ffffff';
  ctx.setLineDash(lineMode ? [3 * px, 2 * px] : []);
  ctx.stroke();
  ctx.setLineDash([]);
};

/** D + drag: the points to remove, crossed out in red; O / L + drag: the
 * points to cut out / align, ringed. */
const drawSelectedMarks = (p: Pen, scene: StageScene, positioned: Positioned[]) => {
  const { ctx, px } = p;
  const pointSelect = pointSelectOf(scene.editMode);
  const selectColor = selectColorOf(scene.editMode);
  positioned
    .filter(({ item }) => scene.selectedItems.has(item))
    .forEach(({ start, end }) => {
      if (end) {
        p.line(start, end);
        ctx.setLineDash([4 * px, 3 * px]);
        ctx.lineWidth = 2 * px;
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.strokeStyle = selectColor;
      ctx.lineWidth = 2.5 * px;
      [start, ...(end ? [end] : [])].forEach(([x, y]) => {
        const arm = 6 * px;
        ctx.beginPath();
        if (pointSelect === 'remove') {
          ctx.moveTo(x - arm, y - arm);
          ctx.lineTo(x + arm, y + arm);
          ctx.moveTo(x + arm, y - arm);
          ctx.lineTo(x - arm, y + arm);
        } else {
          ctx.arc(x, y, 10 * px, 0, FULL_CIRCLE);
        }
        ctx.stroke();
      });
    });
};

/** Group alignment (L): its points haloed, each pin's target a crosshair,
 * the point being dragged follows the mouse. */
const drawGroup = (p: Pen, scene: StageScene, positioned: Positioned[], layout: CanvasLayout) => {
  const { ctx, px } = p;
  const { group, groupDrag } = scene;
  if (!group) {
    return;
  }
  ctx.strokeStyle = GROUP_COLOR;
  ctx.lineWidth = 2 * px;
  positioned
    .filter(({ item }) => group.ids.has(Number(item.point.id)))
    .forEach(({ start, end }) => {
      [start, ...(end ? [end] : [])].forEach((point) => {
        p.circle(point, 9);
        ctx.stroke();
      });
    });
  group.pins.forEach((pin, number) => p.pinMark(fractionToCanvas(pin.target, layout), number, GROUP_COLOR));
  if (groupDrag) {
    p.pinLine(fractionToCanvas(groupDrag.source, layout), groupDrag.at, GROUP_COLOR);
    p.circle(groupDrag.at, 7);
    ctx.fillStyle = GROUP_COLOR;
    ctx.fill();
  }
};

/** I held: the cut points where a click inserts them, dashed. */
const drawInsertGhost = (p: Pen, ghosts: CutItem[] | null, transform: PointTransform) => {
  const { ctx, px } = p;
  if (!ghosts) {
    return;
  }
  ctx.strokeStyle = CUT_COLOR;
  ctx.fillStyle = 'rgba(183, 121, 31, 0.25)';
  ctx.lineWidth = 2 * px;
  ctx.setLineDash([4 * px, 3 * px]);
  ghosts.forEach((ghost) => {
    const start = normalizedToCanvas(ghost.start, transform);
    if (ghost.end) {
      p.line(start, normalizedToCanvas(ghost.end, transform));
      ctx.stroke();
    } else {
      p.circle(start, 6.5);
      ctx.fill();
      ctx.stroke();
    }
  });
  ctx.setLineDash([]);
};

/** Numbers where there is room for them (average distance on screen), the hovered one always. */
const drawMarkerLabels = (
  p: Pen,
  scene: StageScene,
  drawOrder: Positioned[],
  hovered: MarkerItem | null,
  layout: CanvasLayout,
) => {
  const { px } = p;
  const planArea = layout.drawWidth * scene.alignment.scaleX * layout.drawHeight * scene.alignment.scaleY;
  const roomy = drawOrder.length > 0 && Math.sqrt(planArea / drawOrder.length) / px >= LABEL_SPACING;
  drawOrder.forEach(({ item, start, end }) => {
    if (!roomy && item !== hovered) {
      return;
    }
    const [x, y] = end ? [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2] : start;
    p.label(
      scene.lineMode ? `dm ${item.label}` : item.label,
      x + 9 * px,
      end ? y - 9 * px : y,
      item === hovered ? '#101419' : '#343a40',
      item === hovered ? 13 : 11,
    );
  });
};

/** "Align": each pin's target (crosshair, numbered) and a dashed line from
 * where its sensor point lies now - the lines vanish once it fits; the
 * sensor being dragged follows the mouse. */
const drawAlignPins = (p: Pen, scene: StageScene, transform: PointTransform, layout: CanvasLayout) => {
  const { ctx, px } = p;
  const { pins, alignDrag } = scene;
  pins.forEach((pin, number) => {
    const target = fractionToCanvas(pin.target, layout);
    p.pinLine(normalizedToCanvas(pin.source, transform), target, PRIMARY_COLOR);
    p.pinMark(target, number, PRIMARY_COLOR);
  });
  if (alignDrag) {
    p.pinLine(normalizedToCanvas(alignDrag.source, transform), alignDrag.at, PRIMARY_COLOR);
    p.circle(alignDrag.at, 7);
    ctx.fillStyle = scene.items[alignDrag.index]?.color ?? PRIMARY_COLOR;
    ctx.fill();
    ctx.lineWidth = 2 * px;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
  }
};

/** Calibration: the two picked points and the line between them. */
const drawCalibration = (p: Pen, points: ImagePoint[], layout: CanvasLayout) => {
  const { ctx, px } = p;
  if (!points.length) {
    return;
  }
  const [first, second] = points.map((point) => imageToCanvas(point, layout));
  ctx.strokeStyle = '#fd7e14';
  ctx.fillStyle = '#fd7e14';
  ctx.lineWidth = 2 * px;
  if (second) {
    p.line(first, second);
    ctx.stroke();
  }
  [first, second].filter(Boolean).forEach((point) => {
    p.circle(point, 5);
    ctx.fill();
  });
};

/** Reference point (origin of the positions in meters): a crosshair. */
const drawReference = (p: Pen, point: ImagePoint | null, layout: CanvasLayout) => {
  const { ctx, px } = p;
  if (!point) {
    return;
  }
  const at = imageToCanvas(point, layout);
  ctx.strokeStyle = PRIMARY_COLOR;
  ctx.lineWidth = 2 * px;
  p.cross(at, 12);
  ctx.stroke();
  p.circle(at, 6);
  ctx.stroke();
};

/** Draws the whole canvas, in canvas units (logical) at pixelRatio backing pixels each. */
export const drawStage = (ctx: CanvasRenderingContext2D, scene: StageScene) => {
  const { px, logical, image } = scene;
  ctx.setTransform(scene.pixelRatio, 0, 0, scene.pixelRatio, 0, 0);
  const { width, height } = logical;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#f5f6f8';
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingQuality = 'high';

  const layout = canvasLayout(logical, image, scene.view);
  const transform = pointTransform(layout, scene.alignment, scene.view.zoom);
  const p = pen(ctx, px);

  ctx.strokeStyle = '#cfd4da';
  ctx.lineWidth = px;
  ctx.strokeRect(px / 2, px / 2, width - px, height - px);
  ctx.drawImage(image, layout.drawX, layout.drawY, layout.drawWidth, layout.drawHeight);

  // The selected area under the points.
  drawSelectionArea(p, scene, layout);
  drawPlacedSensors(p, scene, transform);

  // Measure points, rainbow-coloured in sensor order; the hovered one is drawn last, on top.
  const hovered = scene.hoveredIndex != null ? (scene.items[scene.hoveredIndex] ?? null) : null;
  const positioned: Positioned[] = (scene.placement ? [] : scene.items).map((item) => ({
    item,
    start: normalizedToCanvas(item.start, transform),
    end: item.end ? normalizedToCanvas(item.end, transform) : null,
  }));
  const drawOrder = hovered
    ? [...positioned.filter((entry) => entry.item !== hovered), ...positioned.filter((entry) => entry.item === hovered)]
    : positioned;
  drawOrder.forEach((entry) => drawMarker(p, entry, entry.item === hovered, scene.lineMode));

  drawSelectedMarks(p, scene, positioned);
  drawGroup(p, scene, positioned, layout);
  drawInsertGhost(p, scene.insertGhost, transform);
  drawMarkerLabels(p, scene, drawOrder, hovered, layout);
  drawAlignPins(p, scene, transform, layout);
  drawCalibration(p, scene.calibrationPoints, layout);
  drawReference(p, scene.referencePoint, layout);
};
