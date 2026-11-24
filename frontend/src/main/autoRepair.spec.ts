import { describe, expect, it } from 'vitest';
import {
  autoPlaces,
  autoRepairProblem,
  autoRepairWarnings,
  freeNumbers,
  mpleLabel,
  newBadgeProblem,
  newPoints,
  nextOpenLine,
  orderedMarks,
  previewPoints,
  reviewedCables,
  type AutoCable,
  type AutoOrderResult,
} from './autoRepair';

const cable = (number: number | null, marks: Array<[number, number]>, extra: Partial<AutoCable> = {}): AutoCable => ({
  number,
  label: number == null ? null : `MPLE ${String(number).padStart(2, '0')}`,
  inferred: false,
  confidence: 0.9,
  head_known: number != null,
  line: [marks[0] ?? [0, 0], marks[marks.length - 1] ?? [0, 0]],
  marks,
  ...extra,
});

const result = (cables: AutoCable[], extra: Partial<AutoOrderResult> = {}): AutoOrderResult => ({
  lageplan_id: 7,
  cables,
  marks: cables.reduce((sum, c) => sum + c.marks.length, 0),
  marks_off_cable: 0,
  labels: cables.filter((c) => c.number != null).length,
  inferred: 0,
  unlabelled: cables.filter((c) => c.number == null).length,
  missing_numbers: [],
  points: 0,
  ocr: true,
  ...extra,
});

const point = (id: number, order: number) => ({ id, sensor_order: order, nx: 0.5, ny: 0.5, name: null });

describe('auto-repair order', () => {
  it('numbers the marks line by line, by MPLE number, each from its head', () => {
    const cables = reviewedCables(
      result([cable(2, [[0.5, 0.1], [0.6, 0.1]]), cable(1, [[0.1, 0.1], [0.2, 0.1], [0.3, 0.1]])]),
      {},
    );

    expect(orderedMarks(cables)).toEqual([[0.1, 0.1], [0.2, 0.1], [0.3, 0.1], [0.5, 0.1], [0.6, 0.1]]);
  });

  it('puts the points by their number onto the marks in order', () => {
    const marks: Array<[number, number]> = [[0.1, 0.2], [0.3, 0.4]];
    // Stored out of order, numbers 5 and 9.
    const places = autoPlaces([point(11, 9), point(12, 5)], marks);

    expect(places).toEqual([
      { id: 12, sensor_order: 5, nx: 0.1, ny: 0.2 },
      { id: 11, sensor_order: 9, nx: 0.3, ny: 0.4 },
    ]);
  });

  it('shows new points for the marks beyond the points, numbered after the highest', () => {
    const marks: Array<[number, number]> = [[0.1, 0.1], [0.2, 0.2], [0.3, 0.3]];
    const created = newPoints(1, marks, 40);

    expect(created).toEqual([
      { id: -1, sensor_order: 41, nx: 0.2, ny: 0.2, name: null },
      { id: -2, sensor_order: 42, nx: 0.3, ny: 0.3, name: null },
    ]);
    const shown = previewPoints([point(1, 1)], autoPlaces([point(1, 1)], marks), created);
    expect(shown.map((p) => [p.sensor_order, p.nx])).toEqual([[1, 0.1], [41, 0.2], [42, 0.3]]);
  });

  it('leaves the highest numbers where they are when there are fewer marks', () => {
    const places = autoPlaces([point(1, 1), point(2, 2), point(3, 3)], [[0.1, 0.1]]);
    expect(places.map((place) => place.id)).toEqual([1]);
    const shown = previewPoints([point(1, 1), point(2, 2)], places);
    expect(shown.map((p) => [p.nx, p.ny])).toEqual([[0.1, 0.1], [0.5, 0.5]]);
  });

  it('takes the review: a number for an unreadable line and a turned direction', () => {
    const answer = result([cable(1, [[0.1, 0.1]]), cable(null, [[0.9, 0.9], [0.8, 0.8]])]);
    const before = reviewedCables(answer, {});
    expect(autoRepairProblem(before)).toBe('1 MPLE line(s) without a number - enter the number from the plan');

    const after = reviewedCables(answer, { 1: { number: 2, reversed: true } });
    expect(autoRepairProblem(after)).toBeNull();
    expect(after[1].line).toEqual([[0.8, 0.8], [0.9, 0.9]]);
    expect(orderedMarks(after)).toEqual([[0.1, 0.1], [0.8, 0.8], [0.9, 0.9]]);
  });

  it('offers the short gaps, freed and created numbers as badges - never one a line has', () => {
    const answer = result(
      [cable(2, [[0.1, 0.1]]), cable(5, [[0.2, 0.2]]), cable(70, [[0.3, 0.3]]), cable(null, [[0.4, 0.4]])],
      // 1, 3-4 are gaps; 6-69 is no run of the plan.
      { missing_numbers: [1, 3, 4, ...Array.from({ length: 64 }, (_, i) => i + 6)] },
    );

    expect(freeNumbers(answer, reviewedCables(answer, {}))).toEqual([1, 3, 4]);
    // MPLE 3 given to the unreadable line, MPLE 5 taken from its line, 99 created.
    const reviewed = reviewedCables(answer, { 3: { number: 3 }, 1: { number: null } });
    expect(freeNumbers(answer, reviewed, [99])).toEqual([1, 4, 5, 99]);
  });

  it('refuses a new badge a line or a badge has already', () => {
    const answer = result([cable(2, [[0.1, 0.1]])], { missing_numbers: [1] });
    const cables = reviewedCables(answer, {});
    const free = freeNumbers(answer, cables);

    expect(newBadgeProblem(7, cables, free)).toBeNull();
    expect(newBadgeProblem(2, cables, free)).toBe('MPLE 2 belongs to a line already');
    expect(newBadgeProblem(1, cables, free)).toBe('MPLE 1 is a badge already');
    expect(newBadgeProblem(0, cables, free)).toBe('A number from 1 up');
  });

  it('moves on to the next line without a number', () => {
    const answer = result([cable(1, [[0.1, 0.1]]), cable(null, [[0.2, 0.2]]), cable(null, []), cable(null, [[0.4, 0.4]])]);
    const cables = reviewedCables(answer, {});

    expect(nextOpenLine(cables, null)).toBe(1);
    expect(nextOpenLine(cables, 1)).toBe(3);
    expect(nextOpenLine(cables, 3)).toBe(1);
    expect(nextOpenLine(reviewedCables(answer, { 1: { number: 2 }, 3: { number: 3 } }), 1)).toBeNull();
    expect(mpleLabel(6)).toBe('MPLE 06');
    expect(mpleLabel(145)).toBe('MPLE 145');
  });

  it('refuses a number given twice and a plan without marks', () => {
    const answer = result([cable(1, [[0.1, 0.1]]), cable(null, [[0.9, 0.9]])]);
    expect(autoRepairProblem(reviewedCables(answer, { 1: { number: 1 } }))).toBe('MPLE 1 used twice');
    expect(autoRepairProblem(reviewedCables(result([cable(1, [])]), {}))).toBe(
      'No sensor marks found on the MPLE lines',
    );
  });

  it('warns about counts that differ, inferred numbers and unknown directions', () => {
    const answer = result([cable(1, [[0.1, 0.1], [0.2, 0.2]], { inferred: true }), cable(null, [[0.5, 0.5], [0.6, 0.6]])], {
      marks_off_cable: 2,
    });
    const warnings = autoRepairWarnings(answer, reviewedCables(answer, { 1: { number: 2 } }), 3);

    expect(warnings).toEqual([
      '4 sensor marks but 3 measure points - 1 new measure point(s) are created for the marks beyond them.',
      '2 sensor mark(s) lie on no MPLE line and are left out.',
      'Some numbers were inferred (label unreadable) - check them on the plan.',
      'Lines without a readable label have no known start - check their direction.',
    ]);
  });
});
