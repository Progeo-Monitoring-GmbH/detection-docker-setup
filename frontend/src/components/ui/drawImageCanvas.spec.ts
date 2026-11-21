import { describe, expect, it } from 'vitest';
import { drawStage, type StageScene } from './drawImageCanvas';
import type { MarkerItem } from './imageCanvasGeometry';

/** A 2D context that records the calls made on it (jsdom draws nothing). */
const recordingContext = () => {
  const calls: Array<[string, unknown[]]> = [];
  const state: Record<string, unknown> = {};
  const ctx = new Proxy(state, {
    get: (target, key: string) =>
      key in target ? target[key] : (...args: unknown[]) => calls.push([key, args]),
    set: (target, key: string, value) => {
      target[key] = value;
      return true;
    },
  });
  const count = (name: string) => calls.filter(([key]) => key === name).length;
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls, count };
};

const item = (id: number, start: [number, number], end: [number, number] | null = null): MarkerItem => ({
  point: { id },
  label: String(id),
  color: `c${id}`,
  start,
  end,
});

const scene = (overrides: Partial<StageScene> = {}): StageScene => ({
  image: { naturalWidth: 1000, naturalHeight: 500 } as StageScene['image'],
  logical: { width: 900, height: 600 },
  pixelRatio: 2,
  px: 1,
  view: { zoom: 1, offsetX: 0, offsetY: 0 },
  alignment: { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1, flipY: true },
  editMode: null,
  selection: null,
  selectedItems: new Set(),
  items: [item(1, [0.2, 0.2]), item(2, [0.5, 0.5], [0.6, 0.5])],
  hoveredIndex: null,
  lineMode: false,
  group: null,
  groupDrag: null,
  insertGhost: null,
  pins: [],
  alignDrag: null,
  calibrationPoints: [],
  referencePoint: null,
  ...overrides,
});

describe('drawStage', () => {
  it('draws the plan scaled to the pixel ratio, then the points', () => {
    const { ctx, calls, count } = recordingContext();
    drawStage(ctx, scene());
    expect(calls[0]).toEqual(['setTransform', [2, 0, 0, 2, 0, 0]]);
    const drawImage = calls.find(([key]) => key === 'drawImage')!;
    expect((drawImage[1][1] as number)).toBeCloseTo(16);
    expect((drawImage[1][2] as number)).toBeCloseTo(83);
    // One dot, one band (stroked twice: halo and colour), both labelled - there is room.
    expect(count('arc')).toBe(1);
    expect(count('fillText')).toBe(2);
  });

  it('draws the hovered point last, and only placed sensors while placing', () => {
    const hovered = recordingContext();
    drawStage(hovered.ctx, scene({ hoveredIndex: 0 }));
    const arcs = hovered.calls.filter(([key]) => key === 'arc');
    const lastArc = arcs[arcs.length - 1];
    expect(lastArc[1][2]).toBe(8.5);

    const placing = recordingContext();
    drawStage(
      placing.ctx,
      scene({ placement: { sensors: [{ deviceId: 3, label: 'AA', nx: 0.5, ny: 0.5 }], activeDeviceId: 3 } }),
    );
    expect(placing.count('arc')).toBe(1);
    expect(placing.calls.filter(([key]) => key === 'fillText').map(([, args]) => args[0])).toEqual(['1', 'AA']);
  });

  it('marks a selection, a group, pins, the calibration and the reference point', () => {
    const items = scene().items;
    const { ctx, count, calls } = recordingContext();
    drawStage(
      ctx,
      scene({
        editMode: 'crop',
        selection: [
          [100, 100],
          [300, 200],
        ],
        group: { ids: new Set([1]), pins: [{ id: 1, source: [0.2, 0.2], target: [0.3, 0.3] }] },
        pins: [{ index: 0, source: [0.2, 0.2], target: [0.4, 0.4] }],
        alignDrag: { index: 1, source: [0.5, 0.5], at: [400, 300] },
        calibrationPoints: [
          [0, 0],
          [100, 0],
        ],
        referencePoint: [50, 50],
        items,
        selectedItems: new Set([items[0]]),
      }),
    );
    expect(calls.some(([key, args]) => key === 'fill' && args[0] === 'evenodd')).toBe(true);
    expect(count('strokeRect')).toBe(2);
    // "1": the group's pin, the calibration's pin and point 1's label.
    expect(calls.filter(([key, args]) => key === 'fillText' && args[0] === '1')).toHaveLength(3);
    expect(count('arc')).toBeGreaterThanOrEqual(7);
  });

  it('crosses out points to remove and draws the cut points to insert', () => {
    const items = scene().items;
    const { ctx, count } = recordingContext();
    drawStage(
      ctx,
      scene({
        editMode: 'remove',
        selection: [
          [0, 0],
          [1000, 500],
        ],
        items,
        selectedItems: new Set(items),
        insertGhost: [
          { id: 7, start: [0.1, 0.1], end: null },
          { id: 8, start: [0.2, 0.2], end: [0.3, 0.3] },
        ],
      }),
    );
    // The tinted area, no arcs for the crosses: the dot plus the inserted dot.
    expect(count('fillRect')).toBe(2);
    expect(count('arc')).toBe(2);
  });
});
