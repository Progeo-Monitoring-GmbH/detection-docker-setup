/**
 * "Auto-Repair" of the sensor order (step 5 of the Lageplan wizard,
 * LageplanAutoRepair.tsx). The backend (measure_points/auto_order,
 * helper/plan_cables.py) reads the plan's MPLE lines: their number from the
 * "MPLE <n>" label, the head (the end the label lies at) and the sensor
 * marks on them. The sensors are numbered line by line - MPLE 1 from its
 * head, then MPLE 2, ... - so the plan's measure points, by their number,
 * go onto the marks in that order (measure_points/auto_order/apply): the
 * numbers (and with them the readings, names, devices) stay, the dots move;
 * marks beyond the points become new points. For an mx-PEEL plan this runs
 * on its own after the upload (AutoRepairStatus).
 *
 * Pure - the review (numbers given to unreadable lines, a direction turned)
 * is a map of edits over the backend's answer.
 */
import type { MeasurePoint } from './lageplanWizardUtils';

export type Coordinates = [number, number];

export type AutoCable = {
  number: number | null;
  label: string | null;
  /** Not read, but the missing number its label fits best. */
  inferred: boolean;
  confidence: number;
  /** The label was found: the head is its end. */
  head_known: boolean;
  /** Head and end as shares of the image (x, y). */
  line: [Coordinates, Coordinates];
  /** The sensor marks (nx, ny of a measure point) from the head on. */
  marks: Coordinates[];
};

export type AutoOrderResult = {
  lageplan_id: number;
  cables: AutoCable[];
  marks: number;
  marks_off_cable: number;
  labels: number;
  inferred: number;
  unlabelled: number;
  missing_numbers: number[];
  /** The plan's measure points. */
  points: number;
  /** OCR available on the server - without it no label is read. */
  ocr: boolean;
};

/** What the review changed on a line (by its index in the answer). */
export type CableEdit = { number?: number | null; reversed?: boolean };
export type CableEdits = Record<number, CableEdit>;

export type ReviewedCable = AutoCable & {
  index: number;
  reversed: boolean;
  /** The number comes from the review, not from the label. */
  numberEdited: boolean;
};

/** The lines with the review applied: numbers given, directions turned. */
export const reviewedCables = (result: AutoOrderResult, edits: CableEdits): ReviewedCable[] =>
  result.cables.map((cable, index) => {
    const edit = edits[index] ?? {};
    const reversed = Boolean(edit.reversed);
    return {
      ...cable,
      index,
      number: edit.number !== undefined ? edit.number : cable.number,
      numberEdited: edit.number !== undefined,
      reversed,
      line: reversed ? [cable.line[1], cable.line[0]] : cable.line,
      marks: reversed ? [...cable.marks].reverse() : cable.marks,
    };
  });

/** Missing numbers in runs longer than this are numbers the plan doesn't have
 * (e.g. 52-69 between MPLE 51 and 70) - as the backend's inference
 * (plan_cables.INFER_MAX_RUN). */
export const BADGE_MAX_RUN = 3;

/** The numbers the review offers as badges: the gaps of what was read (short
 * runs only), the numbers read at first (free again once taken from their
 * line) and the ones created by hand - each once, without the numbers a line
 * has now, ascending. */
export const freeNumbers = (result: AutoOrderResult, cables: ReviewedCable[], created: number[] = []) => {
  const missing = [...result.missing_numbers].sort((a, b) => a - b);
  const gaps: number[] = [];
  let run: number[] = [];
  missing.forEach((number, index) => {
    if (run.length && number !== missing[index - 1] + 1) {
      if (run.length <= BADGE_MAX_RUN) {
        gaps.push(...run);
      }
      run = [];
    }
    run.push(number);
  });
  if (run.length <= BADGE_MAX_RUN) {
    gaps.push(...run);
  }
  const read = result.cables.map((cable) => cable.number).filter((number): number is number => number != null);
  const used = new Set(cables.map((cable) => cable.number).filter((number) => number != null));
  return [...new Set([...gaps, ...read, ...created])].filter((number) => !used.has(number)).sort((a, b) => a - b);
};

/** Why `number` can't be a new badge, else null. */
export const newBadgeProblem = (number: number, cables: ReviewedCable[], free: number[]) => {
  if (!Number.isInteger(number) || number < 1) {
    return 'A number from 1 up';
  }
  if (cables.some((cable) => cable.number === number)) {
    return `MPLE ${number} belongs to a line already`;
  }
  if (free.includes(number)) {
    return `MPLE ${number} is a badge already`;
  }
  return null;
};

/** The next line still without a number (with sensor marks) after `index` - wrapping around; null when none is left. */
export const nextOpenLine = (cables: ReviewedCable[], index: number | null): number | null => {
  const open = cables.filter((cable) => cable.number == null && cable.marks.length > 0).map((cable) => cable.index);
  if (!open.length) {
    return null;
  }
  return open.find((candidate) => index == null || candidate > index) ?? open[0];
};

/** "MPLE 06" - as the plans write the numbers. */
export const mpleLabel = (number: number) => `MPLE ${String(number).padStart(2, '0')}`;

/** The marks in sensor order: the numbered lines by number, each from its head. */
export const orderedMarks = (cables: ReviewedCable[]): Coordinates[] =>
  cables
    .filter((cable) => cable.number != null && cable.marks.length > 0)
    .sort((a, b) => Number(a.number) - Number(b.number))
    .flatMap((cable) => cable.marks);

export type AutoPlace = { id: number; sensor_order: number; nx: number; ny: number };

/** The plan's points by their number onto the marks in order - the first
 * number onto the first mark of the lowest MPLE. Points beyond the marks stay. */
export const autoPlaces = (points: MeasurePoint[], marks: Coordinates[]): AutoPlace[] =>
  points
    .map((point) => ({ id: Number(point.id), sensor_order: Number(point.sensor_order) }))
    .filter((point) => Number.isInteger(point.id) && Number.isFinite(point.sensor_order))
    .sort((a, b) => a.sensor_order - b.sensor_order || a.id - b.id)
    .slice(0, marks.length)
    .map((point, index) => ({ ...point, nx: marks[index][0], ny: marks[index][1] }));

/** The marks beyond the plan's points: new points, numbered after the
 * location's highest number (`highest`) - as measure_points/auto_order/apply
 * creates them. Negative ids: not stored yet. */
export const newPoints = (pointCount: number, marks: Coordinates[], highest: number): MeasurePoint[] =>
  marks.slice(pointCount).map(([nx, ny], index) => ({
    id: -(index + 1),
    sensor_order: highest + index + 1,
    nx,
    ny,
    name: null,
  }));

/** The points as the canvas shows them with the new order - moved onto their
 * marks, and the new ones for the marks beyond them. */
export const previewPoints = (points: MeasurePoint[], places: AutoPlace[], created: MeasurePoint[] = []): MeasurePoint[] => {
  const byId = new Map(places.map((place) => [place.id, place]));
  return [
    ...points.map((point) => {
      const place = byId.get(Number(point.id));
      return place ? { ...point, nx: place.nx, ny: place.ny } : point;
    }),
    ...created,
  ];
};

/** Why the order can't be applied yet, else null. */
export const autoRepairProblem = (cables: ReviewedCable[]): string | null => {
  if (!cables.some((cable) => cable.marks.length > 0)) {
    return 'No sensor marks found on the MPLE lines';
  }
  const open = cables.filter((cable) => cable.number == null && cable.marks.length > 0);
  if (open.length) {
    return `${open.length} MPLE line(s) without a number - enter the number from the plan`;
  }
  const numbers = cables.filter((cable) => cable.number != null).map((cable) => Number(cable.number));
  const twice = [...new Set(numbers.filter((number, index) => numbers.indexOf(number) !== index))];
  if (twice.length) {
    return `MPLE ${twice.sort((a, b) => a - b).join(', ')} used twice`;
  }
  return null;
};

/** What to check before applying (not blocking). */
export const autoRepairWarnings = (result: AutoOrderResult, cables: ReviewedCable[], pointCount: number) => {
  const warnings: string[] = [];
  const marks = cables.reduce((sum, cable) => sum + cable.marks.length, 0);
  if (marks > pointCount) {
    warnings.push(`${marks} sensor marks but ${pointCount} measure points - ${marks - pointCount} new measure point(s) are created for the marks beyond them.`);
  } else if (marks < pointCount) {
    warnings.push(`${pointCount} measure points but only ${marks} sensor marks - the ${pointCount - marks} highest number(s) keep their place.`);
  }
  if (result.marks_off_cable > 0) {
    warnings.push(`${result.marks_off_cable} sensor mark(s) lie on no MPLE line and are left out.`);
  }
  if (cables.some((cable) => cable.inferred && !cable.numberEdited)) {
    warnings.push('Some numbers were inferred (label unreadable) - check them on the plan.');
  }
  if (cables.some((cable) => !cable.head_known && cable.marks.length > 1 && !cable.reversed)) {
    warnings.push('Lines without a readable label have no known start - check their direction.');
  }
  return warnings;
};

/** The state of the Auto-Repair running in the background for an uploaded
 * mx-PEEL plan (measure_points/auto_order/status). */
export type AutoRepairStatus = {
  lageplan_id: number;
  state: 'queued' | 'running' | 'applied' | 'review' | 'failed' | null;
  message?: string;
  placed?: { moved: number; created: number; kept: number } | null;
  result?: AutoOrderResult | null;
};

/** Still going - ask again. */
export const isRunning = (status: AutoRepairStatus | null) =>
  status?.state === 'queued' || status?.state === 'running';
