/**
 * "Repair order" on the plan canvas (sensorOrderRepair.ts): the points as
 * the repair shows them (repairItems - gray until numbered again, labelled
 * with their new number and Klemmliste name) and what is drawn over them
 * (drawRepairOverlay - the areas, the line being drawn with its verdict, the
 * lines drawn green / red by the Klemmliste check).
 */
import type { Pen } from './drawImageCanvas';
import {
  imageToCanvas,
  normalizedToCanvas,
  rainbowColor,
  type CanvasLayout,
  type ImagePoint,
  type MarkerItem,
  type PointTransform,
} from './imageCanvasGeometry';
import {
  REPAIR_COLOR,
  REPAIR_GRAY,
  VERDICT_OK,
  VERDICT_WARN,
  type Klemmliste,
  type RepairResult,
  type Verdict,
} from './sensorOrderRepair';

/** What the canvas draws over the points during a repair. */
export type RepairOverlay = {
  boxes: Array<[ImagePoint, ImagePoint]>;
  /** An area being dragged, and whether it takes points out. */
  drag: { box: [ImagePoint, ImagePoint]; remove: boolean } | null;
  /** The line being drawn: its first click and the mouse (normalized). */
  line: { from: ImagePoint; to: ImagePoint | null } | null;
  /** The lines drawn, from their first to their last point (normalized), and their verdict. */
  lines: Array<{ from: ImagePoint; to: ImagePoint; ok: boolean | null }>;
  /** The verdict of the line being drawn - shown at the mouse. */
  verdict: Verdict | null;
  /** The first point of a swap (normalized). */
  swapFirst: ImagePoint | null;
  /** Screen pixels around a line that catch a point. */
  snap: number;
};

const withName = (order: number, list: Klemmliste | null) => {
  const name = list?.names.get(order);
  return name ? `${order} ${name}` : String(order);
};

/** The points as the repair shows them: the area's gray until numbered (their
 * old number faint), then coloured and labelled by the new number (with the
 * Klemmliste name); the ones a line being drawn catches in the repair colour,
 * labelled with the numbers they would get. */
export const repairItems = (
  items: MarkerItem[],
  result: RepairResult,
  preview: number[],
  list: Klemmliste | null,
): MarkerItem[] => {
  const orders = [...new Set(items.map((item) => Number(item.label)))].sort((a, b) => a - b);
  const rank = new Map(orders.map((order, index) => [order, index]));
  const held = new Set(result.numbers.values());
  const free = result.pool.filter((order) => !held.has(order));
  const previewAt = new Map(preview.map((id, index) => [id, free[index]]));
  return items.map((item) => {
    const id = Number(item.point.id);
    const given = result.numbers.get(id);
    if (previewAt.has(id)) {
      const order = previewAt.get(id);
      return { ...item, color: REPAIR_COLOR, label: order != null ? withName(order, list) : '?', forceLabel: true, labelColor: REPAIR_COLOR };
    }
    if (given != null) {
      return {
        ...item,
        color: rainbowColor(rank.get(given) ?? 0, orders.length),
        label: withName(given, list),
        forceLabel: result.area.has(id) || given !== Number(item.label),
      };
    }
    if (result.area.has(id)) {
      return { ...item, color: REPAIR_GRAY, forceLabel: true, labelColor: '#adb5bd' };
    }
    return item;
  });
};

const box = ({ ctx, px }: Pen, [from, to]: [ImagePoint, ImagePoint], layout: CanvasLayout, color: string, fill: string) => {
  const [[ax, ay], [bx, by]] = [imageToCanvas(from, layout), imageToCanvas(to, layout)];
  const [left, top, width, height] = [Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay)];
  ctx.fillStyle = fill;
  ctx.fillRect(left, top, width, height);
  ctx.setLineDash([6 * px, 4 * px]);
  ctx.lineWidth = 1.5 * px;
  ctx.strokeStyle = color;
  ctx.strokeRect(left, top, width, height);
  ctx.setLineDash([]);
};

/** A thick round stroke (a line's band, a verdict). */
const band = (p: Pen, from: ImagePoint, to: ImagePoint, width: number, color: string) => {
  const { ctx, px } = p;
  ctx.lineCap = 'round';
  p.line(from, to);
  ctx.lineWidth = width * px;
  ctx.strokeStyle = color;
  ctx.stroke();
};

/** The areas and lines under the points. */
export const drawRepairUnder = (p: Pen, overlay: RepairOverlay, transform: PointTransform, layout: CanvasLayout) => {
  overlay.boxes.forEach((area) => box(p, area, layout, REPAIR_COLOR, 'rgba(9, 75, 129, 0.05)'));
  if (overlay.drag) {
    const color = overlay.drag.remove ? VERDICT_WARN : REPAIR_COLOR;
    box(p, overlay.drag.box, layout, color, overlay.drag.remove ? 'rgba(220, 38, 38, 0.08)' : 'rgba(9, 75, 129, 0.1)');
  }
  overlay.lines.forEach(({ from, to, ok }) => {
    const color = ok == null ? 'rgba(9, 75, 129, 0.25)' : ok ? 'rgba(47, 158, 68, 0.35)' : 'rgba(220, 38, 38, 0.4)';
    band(p, normalizedToCanvas(from, transform), normalizedToCanvas(to, transform), 16, color);
  });
  const { line } = overlay;
  if (line?.to) {
    const [from, to] = [normalizedToCanvas(line.from, transform), normalizedToCanvas(line.to, transform)];
    band(p, from, to, overlay.snap * 2, 'rgba(9, 75, 129, 0.18)');
    band(p, from, to, 1.5, REPAIR_COLOR);
  }
};

/** The marks over the points: a line's first click, the first point of a swap, the verdict at the mouse. */
export const drawRepairOver = (p: Pen, overlay: RepairOverlay, transform: PointTransform) => {
  const { ctx, px } = p;
  if (overlay.line) {
    p.circle(normalizedToCanvas(overlay.line.from, transform), 4);
    ctx.fillStyle = REPAIR_COLOR;
    ctx.fill();
  }
  if (overlay.swapFirst) {
    p.circle(normalizedToCanvas(overlay.swapFirst, transform), 12);
    ctx.lineWidth = 3 * px;
    ctx.strokeStyle = '#101419';
    ctx.stroke();
  }
  const { verdict, line } = overlay;
  if (verdict && line?.to) {
    const [x, y] = normalizedToCanvas(line.to, transform);
    p.label(`${verdict.ok ? '✓' : '⚠'} ${verdict.text}`, x + 14 * px, y - 12 * px, verdict.ok ? VERDICT_OK : VERDICT_WARN, 13);
  }
};
