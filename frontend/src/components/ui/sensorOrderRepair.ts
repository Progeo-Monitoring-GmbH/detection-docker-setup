/**
 * "Repair order" on the plan canvas (ImageCanvasStage, step 5 of the Lageplan
 * wizard): the measure points of a broken stretch are numbered again by hand.
 * Pure - the state is the list of what was done (RepairAction), everything
 * shown is replayed from it, so Z (undo) just drops the last action.
 *
 * - Areas (A + drag; Shift adds one, Alt / Ctrl takes points out) select the
 *   points to number again: they turn gray, and their own numbers are handed
 *   out again from the lowest - the rest of the plan keeps its numbers.
 * - Click (C) gives one point the next number, a line (L, two clicks) every
 *   point near it, in order from the first click; Swap (S) exchanges the
 *   numbers of two points anywhere.
 * - The Klemmliste check: the names on the points (the Klemmliste's,
 *   "<Messpunkt>-<MPLE>", e.g. "A11-3") belong to the numbers - a line should
 *   catch exactly one MPLE (one cable), its Messpunkte in a row, all of them.
 *
 * Stored with measure_points/reorder: the dots stay, the numbers (with their
 * name, device, threshold) move to the dots picked for them.
 */
import {
  itemsInSelection,
  normalizedToCanvas,
  type AlignmentValues,
  type ImagePoint,
  type MarkerItem,
  type PlanImage,
  type PointTransform,
} from './imageCanvasGeometry';

export type RepairTool = 'area' | 'click' | 'line' | 'swap';
export const REPAIR_TOOL_KEYS: Record<string, RepairTool> = { a: 'area', c: 'click', l: 'line', s: 'swap' };
/** A plain drag replaces the selection, Shift adds an area, Alt / Ctrl takes points out. */
export type AreaOp = 'new' | 'add' | 'remove';

/** Screen pixels around a drawn line that catch a point. */
export const LINE_SNAP = 14;
export const REPAIR_GRAY = '#b8bec8';
export const REPAIR_COLOR = '#094b81';
export const VERDICT_OK = '#2f9e44';
export const VERDICT_WARN = '#dc2626';

export type RepairAction =
  | { type: 'area'; op: AreaOp; box: [ImagePoint, ImagePoint]; ids: number[] }
  | { type: 'assign'; how: 'click' | 'line'; ids: number[] }
  | { type: 'swap'; a: number; b: number };

/** A measure point as the repair sees it: its id, stored number and name. */
export type RepairPoint = { id: number; order: number; name: string };

export const repairPointsOf = (items: MarkerItem[]): RepairPoint[] =>
  items
    .map((item) => ({ id: Number(item.point.id), order: Number(item.label), name: String(item.point.name ?? '').trim() }))
    .filter((point) => Number.isInteger(point.id) && Number.isFinite(point.order));

/** What the actions add up to. */
export type RepairResult = {
  /** The points numbered again (ids). */
  area: Set<number>;
  /** The areas dragged (image pixels) - not the ones taking points out. */
  boxes: Array<[ImagePoint, ImagePoint]>;
  /** The area's own numbers, ascending - handed out again. */
  pool: number[];
  /** New numbers by point id (area points numbered so far, swapped points). */
  numbers: Map<number, number>;
  /** The lines drawn (L), their point ids in line order. */
  lines: number[][];
  /** The number the next point gets - null once the area is numbered. */
  next: number | null;
  /** Area points numbered / all of them. */
  done: number;
  total: number;
};

/** Replays the actions over the points (stored numbers). */
export const replayRepair = (actions: RepairAction[], points: RepairPoint[]): RepairResult => {
  const stored = new Map(points.map((point) => [point.id, point.order]));
  let area = new Set<number>();
  let boxes: Array<[ImagePoint, ImagePoint]> = [];
  // A new selection (plain drag) starts over: what was done before it no longer counts.
  const lastNew = actions.map((action) => action.type === 'area' && action.op === 'new').lastIndexOf(true);
  const live = actions.slice(Math.max(lastNew, 0));
  // First pass: the area (its numbers decide what the assignments get).
  live.forEach((action) => {
    if (action.type !== 'area') {
      return;
    }
    if (action.op === 'new') {
      area = new Set(action.ids);
      boxes = [action.box];
    } else if (action.op === 'add') {
      action.ids.forEach((id) => area.add(id));
      boxes = [...boxes, action.box];
    } else {
      action.ids.forEach((id) => area.delete(id));
    }
  });
  const pool = [...area].map((id) => stored.get(id)).filter((order): order is number => order != null).sort((a, b) => a - b);

  const numbers = new Map<number, number>();
  const lines: number[][] = [];
  const nextFree = () => {
    const held = new Set(numbers.values());
    return pool.find((order) => !held.has(order)) ?? null;
  };
  /** The number a point shows now - null for an area point not numbered yet. */
  const current = (id: number) => numbers.get(id) ?? (area.has(id) ? null : (stored.get(id) ?? null));
  live.forEach((action) => {
    if (action.type === 'assign') {
      const given = action.ids.filter((id) => area.has(id) && !numbers.has(id));
      given.forEach((id) => {
        const order = nextFree();
        if (order != null) {
          numbers.set(id, order);
        }
      });
      if (action.how === 'line' && given.length) {
        lines.push(given.filter((id) => numbers.has(id)));
      }
    } else if (action.type === 'swap') {
      const [a, b] = [current(action.a), current(action.b)];
      if (a != null && b != null) {
        numbers.set(action.a, b);
        numbers.set(action.b, a);
      }
    }
  });
  const done = [...area].filter((id) => numbers.has(id)).length;
  return { area, boxes, pool, numbers, lines, next: nextFree(), done, total: area.size };
};

/** The number a point shows during the repair - null: in the area, not numbered yet. */
export const shownNumber = (result: RepairResult, point: RepairPoint) =>
  result.numbers.get(point.id) ?? (result.area.has(point.id) ? null : point.order);

/** The points an area holds (image pixels, as drawn under the alignment). */
export const pointsInArea = (
  items: MarkerItem[],
  box: [ImagePoint, ImagePoint],
  alignment: AlignmentValues,
  image: PlanImage,
): number[] =>
  [...itemsInSelection(items, box, alignment, image)]
    .map((item) => Number(item.point.id))
    .filter((id) => Number.isInteger(id));

/** Where a point lies for a line: a dot, or the middle of a dm band (canvas units). */
const anchorOf = (item: MarkerItem, transform: PointTransform): ImagePoint => {
  const start = normalizedToCanvas(item.start, transform);
  if (!item.end) {
    return start;
  }
  const end = normalizedToCanvas(item.end, transform);
  return [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
};

/** The points a line from `from` to `to` (normalized) catches - within `snap`
 * canvas units of it, ordered from `from` on. Only `candidates` (ids). */
export const pointsOnLine = (
  items: MarkerItem[],
  candidates: Set<number>,
  from: ImagePoint,
  to: ImagePoint,
  transform: PointTransform,
  snap: number,
): number[] => {
  const a = normalizedToCanvas(from, transform);
  const b = normalizedToCanvas(to, transform);
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) {
    return [];
  }
  const slack = snap / Math.sqrt(lengthSq);
  return items
    .filter((item) => candidates.has(Number(item.point.id)))
    .map((item) => {
      const [x, y] = anchorOf(item, transform);
      const t = ((x - a[0]) * dx + (y - a[1]) * dy) / lengthSq;
      const distance = Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy));
      return { id: Number(item.point.id), t, distance };
    })
    .filter((entry) => entry.t >= -slack && entry.t <= 1 + slack && entry.distance <= snap)
    .sort((p, q) => p.t - q.t)
    .map((entry) => entry.id);
};

// ---------------------------------------------------------------------------- the Klemmliste check

/** A Klemmliste name "<Messpunkt>-<MPLE>" ("A11-3": Messpunkt 11 of MPLE 3), else null. */
export const parseSensorName = (name: string | null | undefined): { point: number; line: string } | null => {
  const match = /^(?:.*\D)?(\d+)\s*-\s*([^-\s]+)$/.exec(String(name ?? '').trim());
  return match ? { point: Number(match[1]), line: match[2] } : null;
};

/** The Klemmliste as the points carry it: name by number, points per MPLE. */
export type Klemmliste = { names: Map<number, string>; lineSizes: Map<string, number> };

/** The names of the points by number - null when too few points have a
 * Klemmliste name for a check (under half of `numbers`). */
export const klemmlisteOf = (points: RepairPoint[], numbers?: number[]): Klemmliste | null => {
  const names = new Map<number, string>();
  points.forEach((point) => {
    if (point.name && !names.has(point.order)) {
      names.set(point.order, point.name);
    }
  });
  const lineSizes = new Map<string, number>();
  names.forEach((name) => {
    const parsed = parseSensorName(name);
    if (parsed) {
      lineSizes.set(parsed.line, (lineSizes.get(parsed.line) ?? 0) + 1);
    }
  });
  const checked = numbers ?? points.map((point) => point.order);
  const named = checked.filter((order) => parseSensorName(names.get(order))).length;
  return checked.length && named * 2 >= checked.length ? { names, lineSizes } : null;
};

export type Verdict = { ok: boolean; line: string | null; text: string };

/** Do the numbers a line got (in line order) make one MPLE, its Messpunkte in a row, all of them? */
export const lineVerdict = (numbers: number[], list: Klemmliste): Verdict => {
  const parsed = numbers.map((order) => parseSensorName(list.names.get(order)));
  const missing = numbers.filter((_order, index) => !parsed[index]);
  if (missing.length) {
    return { ok: false, line: null, text: `no Klemmliste name for ${missing.join(', ')}` };
  }
  const named = parsed as Array<{ point: number; line: string }>;
  const lines = [...new Set(named.map((entry) => entry.line))];
  if (lines.length > 1) {
    return { ok: false, line: null, text: `crosses MPLE ${lines.join(' and ')}` };
  }
  const [line] = lines;
  const points = named.map((entry) => entry.point);
  const step = points.length > 1 ? Math.sign(points[1] - points[0]) : 1;
  for (let index = 1; index < points.length; index += 1) {
    if (step === 0 || points[index] - points[index - 1] !== step) {
      return { ok: false, line, text: `MPLE ${line}: ${points[index - 1]} → ${points[index]} not in a row` };
    }
  }
  const size = list.lineSizes.get(line) ?? points.length;
  if (points.length !== size) {
    return {
      ok: false,
      line,
      text: `MPLE ${line} has ${size} sensors, the line ${points.length}${points.length < size ? ' - one missing on the plan?' : ''}`,
    };
  }
  const nameOf = (order: number) => list.names.get(order) ?? String(order);
  return { ok: true, line, text: `MPLE ${line} · ${nameOf(numbers[0])} … ${nameOf(numbers[numbers.length - 1])}` };
};

/** The MPLEs of the area's numbers that no line holds yet. */
export const openLines = (result: RepairResult, list: Klemmliste, verdicts: Verdict[]) => {
  const covered = new Set(verdicts.map((verdict) => verdict.line).filter(Boolean));
  const inArea = result.pool.map((order) => parseSensorName(list.names.get(order))?.line).filter((line): line is string => !!line);
  return [...new Set(inArea)].filter((line) => !covered.has(line));
};

// ---------------------------------------------------------------------------- storing

/** What can be stored: the area numbered through, no number twice, something changed. */
export const repairProblem = (result: RepairResult, points: RepairPoint[]): string | null => {
  if (result.done < result.total) {
    return `${result.total - result.done} point(s) of the area have no number yet`;
  }
  const shown = points.map((point) => shownNumber(result, point));
  const twice = [...new Set(shown.filter((order, index) => order != null && shown.indexOf(order) !== index))];
  if (twice.length) {
    return `Number(s) ${twice.slice(0, 5).join(', ')} twice - swap them apart`;
  }
  return reorderPayload(result, points).length ? null : 'Nothing changed yet';
};

/** measure_points/reorder's orders: the points whose number changed. */
export const reorderPayload = (result: RepairResult, points: RepairPoint[]) =>
  points
    .map((point) => ({ id: point.id, sensor_order: shownNumber(result, point), stored: point.order }))
    .filter((entry): entry is { id: number; sensor_order: number; stored: number } =>
      entry.sensor_order != null && entry.sensor_order !== entry.stored)
    .map(({ id, sensor_order }) => ({ id, sensor_order }));
