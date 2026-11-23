import { describe, expect, it } from 'vitest';
import { markerItems, type ImagePoint, type PointTransform } from './imageCanvasGeometry';
import {
  klemmlisteOf,
  lineVerdict,
  openLines,
  parseSensorName,
  pointsOnLine,
  reorderPayload,
  repairPointsOf,
  repairProblem,
  replayRepair,
  type RepairAction,
} from './sensorOrderRepair';

const BOX: [ImagePoint, ImagePoint] = [
  [0, 0],
  [1, 1],
];

/** A plan like the Leipzig one: 3 cables (MPLE 1-3, x = 0.1 / 0.2 / 0.3) of
 * 3 sensors (y = 0.1 / 0.2 / 0.3), numbered row by row instead of along the cables. */
const broken = () =>
  markerItems(
    [0, 1, 2].flatMap((row) =>
      [0, 1, 2].map((cable) => ({
        id: 100 + cable * 3 + row,
        sensor_order: row * 3 + cable + 1,
        // The Klemmliste names the inputs: input n is Messpunkt A<row> of its MPLE, along the cables.
        name: `A${((row * 3 + cable) % 3) + 1}-${Math.floor((row * 3 + cable) / 3) + 1}`,
        nx: 0.1 * (cable + 1),
        ny: 0.1 * (row + 1),
      })),
    ),
  );

/** Normalized 0..1 -> canvas 0..1000, no offset. */
const TRANSFORM = {
  scale: 1,
  drawWidth: 1000,
  drawHeight: 1000,
  drawX: 0,
  drawY: 0,
  offsetX: 0,
  offsetY: 0,
  scaleX: 1,
  scaleY: 1,
  flipY: false,
  zoom: 1,
} as PointTransform;

const cable = (index: number) => [0, 1, 2].map((row) => 100 + index * 3 + row);
const all = () => [0, 1, 2].flatMap(cable);

describe('replayRepair', () => {
  it('hands the area its own numbers again, from the lowest, in the order lines and clicks take them', () => {
    const points = repairPointsOf(broken());
    const actions: RepairAction[] = [
      { type: 'area', op: 'new', box: BOX, ids: all() },
      { type: 'assign', how: 'line', ids: cable(0) },
      { type: 'assign', how: 'click', ids: [cable(1)[0]] },
    ];

    const result = replayRepair(actions, points);

    expect(result.pool).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(cable(0).map((id) => result.numbers.get(id))).toEqual([1, 2, 3]);
    expect(result.numbers.get(cable(1)[0])).toBe(4);
    expect([result.next, result.done, result.total]).toEqual([5, 4, 9]);
    expect(result.lines).toEqual([cable(0)]);
  });

  it('numbers an area point once - a second line over it skips it', () => {
    const points = repairPointsOf(broken());
    const result = replayRepair(
      [
        { type: 'area', op: 'new', box: BOX, ids: all() },
        { type: 'assign', how: 'line', ids: cable(0) },
        { type: 'assign', how: 'line', ids: [cable(0)[2], ...cable(1)] },
      ],
      points,
    );
    expect(cable(1).map((id) => result.numbers.get(id))).toEqual([4, 5, 6]);
    expect(result.lines[1]).toEqual(cable(1));
  });

  it('adds and takes out areas - the numbers given are handed out again over the new pool', () => {
    const points = repairPointsOf(broken());
    // Cable 1 only (numbers 2, 5, 8), then cable 0 added (1, 4, 7), then its last point taken out.
    const result = replayRepair(
      [
        { type: 'area', op: 'new', box: BOX, ids: cable(1) },
        { type: 'assign', how: 'line', ids: cable(1) },
        { type: 'area', op: 'add', box: BOX, ids: cable(0) },
        { type: 'area', op: 'remove', box: BOX, ids: [cable(0)[2]] },
      ],
      points,
    );
    expect(result.pool).toEqual([1, 2, 4, 5, 8]);
    expect(cable(1).map((id) => result.numbers.get(id))).toEqual([1, 2, 4]);
    expect(result.boxes).toHaveLength(2);
    expect([result.done, result.total, result.next]).toEqual([3, 5, 5]);
  });

  it('starts over with a new selection - what was done before is dropped', () => {
    const points = repairPointsOf(broken());
    const result = replayRepair(
      [
        { type: 'area', op: 'new', box: BOX, ids: cable(0) },
        { type: 'assign', how: 'line', ids: cable(0) },
        { type: 'area', op: 'new', box: BOX, ids: cable(2) },
      ],
      points,
    );
    expect([...result.area]).toEqual(cable(2));
    expect(result.numbers.size).toBe(0);
  });

  it('swaps the numbers of two points anywhere - not of a point still without one', () => {
    const points = repairPointsOf(broken());
    const outside = cable(2)[0]; // number 3, not in the area
    const result = replayRepair(
      [
        { type: 'area', op: 'new', box: BOX, ids: cable(0) },
        { type: 'assign', how: 'click', ids: [cable(0)[0]] },
        { type: 'swap', a: cable(0)[0], b: outside },
        { type: 'swap', a: cable(0)[1], b: outside }, // cable(0)[1] has no number yet
      ],
      points,
    );
    expect(result.numbers.get(cable(0)[0])).toBe(3);
    expect(result.numbers.get(outside)).toBe(1);
    // The numbers 1 is held outside now - the area goes on with 4.
    expect(result.next).toBe(4);
  });
});

describe('pointsOnLine', () => {
  it('catches the points near the line, ordered from the first click', () => {
    const items = broken();
    const ids = pointsOnLine(items, new Set(all()), [0.1, 0.35], [0.1, 0.05], TRANSFORM, 14);
    expect(ids).toEqual([...cable(0)].reverse());
  });

  it('only takes the candidates, and nothing for a line of no length', () => {
    const items = broken();
    expect(pointsOnLine(items, new Set([cable(0)[1]]), [0.1, 0.05], [0.1, 0.35], TRANSFORM, 14)).toEqual([cable(0)[1]]);
    expect(pointsOnLine(items, new Set(all()), [0.1, 0.1], [0.1, 0.1], TRANSFORM, 14)).toEqual([]);
  });
});

describe('the Klemmliste check', () => {
  it('reads "<Messpunkt>-<MPLE>" names', () => {
    expect(parseSensorName('A11-3')).toEqual({ point: 11, line: '3' });
    expect(parseSensorName(' MP 4 - 12 ')).toEqual({ point: 4, line: '12' });
    expect(parseSensorName('D_124')).toBeNull();
    expect(parseSensorName('')).toBeNull();
  });

  it('is off without enough Klemmliste names', () => {
    const points = repairPointsOf(markerItems([1, 2, 3].map((order) => ({ id: order, sensor_order: order, nx: 0, ny: 0, name: order === 1 ? 'A1-1' : '' }))));
    expect(klemmlisteOf(points)).toBeNull();
  });

  it('passes one whole MPLE in a row, either direction', () => {
    const list = klemmlisteOf(repairPointsOf(broken()))!;
    expect(lineVerdict([1, 2, 3], list)).toEqual({ ok: true, line: '1', text: 'MPLE 1 · A1-1 … A3-1' });
    expect(lineVerdict([6, 5, 4], list).ok).toBe(true);
  });

  it('warns about a line crossing MPLEs, a gap and a missing sensor', () => {
    const list = klemmlisteOf(repairPointsOf(broken()))!;
    expect(lineVerdict([3, 4], list)).toMatchObject({ ok: false, text: 'crosses MPLE 1 and 2' });
    expect(lineVerdict([1, 3, 2], list)).toMatchObject({ ok: false, line: '1', text: 'MPLE 1: 1 → 3 not in a row' });
    expect(lineVerdict([4, 5], list)).toMatchObject({
      ok: false,
      text: 'MPLE 2 has 3 sensors, the line 2 - one missing on the plan?',
    });
  });

  it('lists the MPLEs of the area no line holds yet', () => {
    const points = repairPointsOf(broken());
    const result = replayRepair(
      [
        { type: 'area', op: 'new', box: BOX, ids: all() },
        { type: 'assign', how: 'line', ids: cable(0) },
      ],
      points,
    );
    const list = klemmlisteOf(points)!;
    const verdicts = result.lines.map((ids) => lineVerdict(ids.map((id) => result.numbers.get(id)!), list));
    expect(verdicts[0].ok).toBe(true);
    expect(openLines(result, list, verdicts)).toEqual(['2', '3']);
  });
});

describe('storing', () => {
  it('needs the whole area numbered, no number twice - and sends only the changed points', () => {
    const points = repairPointsOf(broken());
    const lines: RepairAction[] = [0, 1, 2].map((index) => ({ type: 'assign', how: 'line', ids: cable(index) }));
    const area: RepairAction = { type: 'area', op: 'new', box: BOX, ids: all() };

    expect(repairProblem(replayRepair([area, lines[0]], points), points)).toBe('6 point(s) of the area have no number yet');
    const repaired = replayRepair([area, ...lines], points);
    expect(repairProblem(repaired, points)).toBeNull();
    // Along the cables now: cable 0 = 1, 2, 3 - its first point (1) and the middle one (5) stay.
    expect(reorderPayload(repaired, points)).toEqual(
      expect.arrayContaining([
        { id: cable(0)[1], sensor_order: 2 },
        { id: cable(1)[0], sensor_order: 4 },
      ]),
    );
    expect(reorderPayload(repaired, points).map((entry) => entry.id)).not.toContain(cable(0)[0]);
    expect(reorderPayload(repaired, points).map((entry) => entry.id)).not.toContain(cable(1)[1]);
    expect(repairProblem(replayRepair([], points), points)).toBe('Nothing changed yet');
  });
});
