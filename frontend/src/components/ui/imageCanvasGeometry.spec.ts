import { describe, expect, it } from 'vitest';
import {
  alignmentBaseScale,
  calibrationDistance,
  canvasLayout,
  canvasToFraction,
  canvasToImage,
  canvasToNormalized,
  clientToCanvas,
  compactCanvasWidth,
  cutItemsOf,
  cutPlacedAt,
  fractionToCanvas,
  grabbedPoint,
  imageToCanvas,
  itemsImageArea,
  itemsInSelection,
  keptInView,
  markerItems,
  MAX_ZOOM,
  MIN_CANVAS_WIDTH,
  nearestItem,
  normalizedToCanvas,
  normalizedToImage,
  onPlanFraction,
  pixelRatioFor,
  pointIdsOf,
  pointTransform,
  positiveNumber,
  selectedItemsOf,
  shownItemsOf,
  stageGeometry,
  rainbowColor,
  sameAlignment,
  segmentDistance,
  selectionRect,
  sensorAtPoint,
  storedAlignment,
  viewForImageArea,
  wheelZoomFactor,
  zoomedView,
  type AlignmentValues,
  type MarkerItem,
} from './imageCanvasGeometry';

// The 1000 x 500 plan of ImageCanvasStage.spec: fits the canvas at 0.868, drawn from (16, 83).
const image = { naturalWidth: 1000, naturalHeight: 500 };
const plain: AlignmentValues = { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1, flipY: false };
const canvas = { width: 900, height: 600 };
const home = { zoom: 1, offsetX: 0, offsetY: 0 };
const layout = canvasLayout(canvas, image, home);

const item = (start: [number, number], end: [number, number] | null = null, id = 1): MarkerItem => ({
  point: { id },
  label: String(id),
  color: 'red',
  start,
  end,
});

describe('layout and coordinate systems', () => {
  it('fits the plan at zoom 1, in the middle', () => {
    expect(alignmentBaseScale(1000, 500)).toBeCloseTo(0.868);
    expect(layout.drawX).toBeCloseTo(16);
    expect(layout.drawY).toBeCloseTo(83);
    expect(canvasLayout({ width: 900, height: 600 }, image, { zoom: 2, offsetX: 10, offsetY: -5 }).scale).toBeCloseTo(1.736);
  });

  it('never scales a small plan above 1.5', () => {
    expect(alignmentBaseScale(10, 10)).toBe(1.5);
  });

  it('makes the canvas only as wide as the plan needs, within its limits', () => {
    expect(compactCanvasWidth(null)).toBe(900);
    expect(compactCanvasWidth(image)).toBe(900);
    expect(compactCanvasWidth({ naturalWidth: 100, naturalHeight: 1000 })).toBe(MIN_CANVAS_WIDTH);
  });

  it('round-trips normalized points over the canvas, flipped or not', () => {
    for (const alignment of [plain, { offsetX: 12, offsetY: -7, scaleX: 1.2, scaleY: 0.8, flipY: true }]) {
      const transform = pointTransform(layout, alignment, 1);
      const back = canvasToNormalized(normalizedToCanvas([0.3, 0.6], transform), transform);
      expect(back[0]).toBeCloseTo(0.3);
      expect(back[1]).toBeCloseTo(0.6);
    }
  });

  it('places a normalized point on the image as the canvas draws it', () => {
    const transform = pointTransform(layout, { ...plain, flipY: true }, 1);
    const [x, y] = normalizedToImage([0.3, 0.6], { ...plain, flipY: true }, 1000, 500);
    expect([x, y]).toEqual([300, 200]);
    const [cx, cy] = imageToCanvas([x, y], layout);
    const [nx, ny] = normalizedToCanvas([0.3, 0.6], transform);
    expect(cx).toBeCloseTo(nx);
    expect(cy).toBeCloseTo(ny);
  });

  it('finds the image pixel under a canvas point - null off the plan, unless moved onto it', () => {
    const [x, y] = canvasToImage(imageToCanvas([250, 100], layout), layout, image)!;
    expect(x).toBeCloseTo(250);
    expect(y).toBeCloseTo(100);
    expect(canvasToImage([5, 5], layout, image)).toBeNull();
    expect(canvasToImage([5, 5], layout, image, true)).toEqual([0, 0]);
    expect(canvasToImage([2000, 2000], layout, image, true)).toEqual([1000, 500]);
  });

  it('converts between canvas units and fractions of the plan', () => {
    const at = fractionToCanvas([0.25, 0.75], layout);
    const [fx, fy] = canvasToFraction(at, layout);
    expect(fx).toBeCloseTo(0.25);
    expect(fy).toBeCloseTo(0.75);
    expect(onPlanFraction([-0.04, 1.04])).toBe(true);
    expect(onPlanFraction([-0.06, 0.5])).toBe(false);
  });

  it('scales the mouse on the shown canvas to canvas units', () => {
    expect(clientToCanvas({ clientX: 250, clientY: 160 }, { left: 10, top: 10, width: 450, height: 300 })).toEqual([480, 300]);
    expect(clientToCanvas({ clientX: 1, clientY: 1 }, { left: 0, top: 0, width: 0, height: 0 })).toBeNull();
  });
});

describe('zoom', () => {
  it('zooms around the middle, and around a point keeping it in place', () => {
    expect(zoomedView(home, 1.5, 900)).toEqual({ zoom: 1.5, offsetX: 0, offsetY: 0 });
    const view = zoomedView(home, 2, 900, [650, 300]);
    expect(view).toEqual({ zoom: 2, offsetX: -200, offsetY: 0 });
    // The plan point under (650, 300) stays there.
    const before = canvasToImage([650, 300], layout, image)!;
    const after = canvasToImage([650, 300], canvasLayout(canvas, image, view), image)!;
    expect(after[0]).toBeCloseTo(before[0]);
    expect(after[1]).toBeCloseTo(before[1]);
  });

  it('fits an image area into the canvas, in its middle (F)', () => {
    const area: [[number, number], [number, number]] = [
      [600, 100],
      [400, 300],
    ];
    const view = viewForImageArea(area, canvas, image, 0);
    // 200 x 200 image pixels in 900 x 600: the height decides.
    expect(view.zoom * alignmentBaseScale(1000, 500) * 200).toBeCloseTo(600);
    const fitted = canvasLayout(canvas, image, view);
    const [left, top] = imageToCanvas([400, 100], fitted);
    const [right, bottom] = imageToCanvas([600, 300], fitted);
    expect((left + right) / 2).toBeCloseTo(450);
    expect(top).toBeCloseTo(0);
    expect(bottom).toBeCloseTo(600);
    expect(viewForImageArea([[0, 0], [0, 0]], canvas, image).zoom).toBe(MAX_ZOOM);
  });

  it('keeps some of the plan in the canvas', () => {
    expect(keptInView(home, canvas, image)).toBe(home);
    expect(keptInView({ ...home, offsetX: 5000 }, canvas, null).offsetX).toBe(5000);
    const kept = keptInView({ zoom: 1, offsetX: 5000, offsetY: -5000 }, canvas, image);
    const shown = canvasLayout(canvas, image, kept);
    // 120 canvas units of the plan are left in the canvas - a quarter of its
    // height where that is less (434 high: 108.5).
    expect(canvas.width - shown.drawX).toBeCloseTo(120);
    expect(shown.drawY + shown.drawHeight).toBeCloseTo(108.5);
  });

  it('frames measure points in image pixels, one point with the plan around it', () => {
    const transform = pointTransform(layout, plain, 1);
    const area = itemsImageArea([item([0.2, 0.2], [0.4, 0.2]), item([0.3, 0.6])], transform, image)!;
    expect(area[0][0]).toBeCloseTo(200);
    expect(area[1][0]).toBeCloseTo(400);
    expect(area[0][1]).toBeCloseTo(100);
    expect(area[1][1]).toBeCloseTo(300);
    const single = itemsImageArea([item([0.5, 0.5])], transform, image)!;
    expect(single[1][0] - single[0][0]).toBeCloseTo(80);
    expect(itemsImageArea([], transform, image)).toBeNull();
  });

  it('stops at the zoom limits', () => {
    expect(zoomedView({ ...home, zoom: 18 }, 2, 900).zoom).toBe(MAX_ZOOM);
  });

  it('turns a wheel step into a zoom factor, lines as 16 pixels, capped', () => {
    expect(wheelZoomFactor({ deltaMode: 0, deltaY: -100 })).toBeCloseTo(Math.exp(0.15));
    expect(wheelZoomFactor({ deltaMode: 1, deltaY: 3 })).toBeCloseTo(Math.exp(-48 * 0.0015));
    expect(wheelZoomFactor({ deltaMode: 0, deltaY: 1000 })).toBeCloseTo(Math.exp(-120 * 0.0015));
  });
});

describe('measure points', () => {
  it('sorts them by sensor order, leaves out those without a place, colours them along', () => {
    const items = markerItems([
      { id: 1, sensor_order: 3, nx: 0.1, ny: 0.1 },
      { id: 2, pos: 1, nx: '0.2', ny: 0.2, nx_end: 0.3, ny_end: 0.3 },
      { id: 3, sensor_order: 2, nx: null, ny: 0.5 },
      { id: 4, nx: 0.4, ny: 0.4, nx_end: '', ny_end: 0.1 },
    ]);
    expect(items.map((entry) => entry.label)).toEqual(['1', '3', '4']);
    expect(items[0].end).toEqual([0.3, 0.3]);
    expect(items[2].end).toBeNull();
    expect(items.map((entry) => entry.color)).toEqual([rainbowColor(0, 3), rainbowColor(1, 3), rainbowColor(2, 3)]);
  });

  it('finds the closest point or dm line within the tolerance', () => {
    const transform = pointTransform(layout, plain, 1);
    const items = [item([0.2, 0.2]), item([0.5, 0.2], [0.5, 0.8], 2)];
    const atFirst = normalizedToCanvas([0.2, 0.2], transform);
    expect(nearestItem(items, [atFirst[0] + 3, atFirst[1]], transform, 8)).toBe(0);
    const onLine = normalizedToCanvas([0.5, 0.5], transform);
    expect(nearestItem(items, [onLine[0] + 5, onLine[1]], transform, 8)).toBe(1);
    expect(nearestItem(items, [onLine[0] + 20, onLine[1]], transform, 8)).toBeNull();
  });

  it('grabs a dm line where it was pressed, on the stored line', () => {
    const transform = pointTransform(layout, plain, 1);
    const stored = item([0.2, 0.2], [0.6, 0.2]);
    const shown = item([0.3, 0.4], [0.7, 0.4]);
    const at = normalizedToCanvas([0.4, 0.4], transform);
    const [x, y] = grabbedPoint(stored, shown, at, transform);
    expect(x).toBeCloseTo(0.3);
    expect(y).toBeCloseTo(0.2);
    expect(grabbedPoint(item([0.1, 0.1]), item([0.9, 0.9]), at, transform)).toEqual([0.1, 0.1]);
  });

  it('selects the points with a start or end inside the area', () => {
    const items = [item([0.1, 0.1], null, 1), item([0.8, 0.8], [0.3, 0.3], 2), item([0.9, 0.9], null, 3)];
    const selected = itemsInSelection(items, [[400, 200], [0, 0]], plain, image);
    expect([...selected].map((entry) => entry.point.id)).toEqual([1, 2]);
  });

  it('applies a selection only once it is big enough', () => {
    expect(selectionRect(null)).toBeNull();
    expect(selectionRect([[10, 10], [11, 40]])).toBeNull();
    expect(selectionRect([[30, 40], [10, 10]])).toEqual({ x: 10, y: 10, width: 20, height: 30 });
  });

  it('measures the distance to a segment, and to a degenerate one', () => {
    expect(segmentDistance([5, 5], [0, 0], [10, 0])).toBe(5);
    expect(segmentDistance([13, 4], [0, 0], [10, 0])).toBe(5);
    expect(segmentDistance([3, 4], [0, 0], [0, 0])).toBe(5);
  });

  it('finds the topmost placed sensor within the radius', () => {
    const transform = pointTransform(layout, plain, 1);
    const sensors = [
      { deviceId: 1, nx: 0.5, ny: 0.5 },
      { deviceId: 2, nx: 0.5, ny: 0.5 },
    ];
    const at = normalizedToCanvas([0.5, 0.5], transform);
    expect(sensorAtPoint(sensors, at, transform, 12)?.deviceId).toBe(2);
    expect(sensorAtPoint(sensors, [at[0] + 20, at[1]], transform, 12)).toBeNull();
  });
});

describe('what is shown and selected', () => {
  const items = [item([0.1, 0.1], null, 1), item([0.5, 0.5], null, 2), { ...item([0.2, 0.2]), point: { id: 'new' } }];

  it('moves a group being aligned where its pins put it', () => {
    const shift = { x: { slope: 1, intercept: 0.1 }, y: { slope: 1, intercept: 0 } };
    const moved = shownItemsOf(items, { ids: new Set([2]) }, shift, plain, image);
    expect(moved[0]).toBe(items[0]);
    expect(moved[1].start[0]).toBeCloseTo(0.6);
    expect(moved[1].start[1]).toBeCloseTo(0.5);
    expect(shownItemsOf(items, { ids: new Set([2]) }, null, plain, image)).toBe(items);
    expect(shownItemsOf(items, null, shift, plain, image)).toBe(items);
  });

  it('selects points only for a point selection with an area and the image', () => {
    const area: [[number, number], [number, number]] = [[0, 0], [600, 300]];
    expect(selectedItemsOf(true, items, area, plain, image).size).toBe(3);
    expect(selectedItemsOf(false, items, area, plain, image).size).toBe(0);
    expect(selectedItemsOf(true, items, null, plain, image).size).toBe(0);
    expect(selectedItemsOf(true, items, area, plain, null).size).toBe(0);
    expect(pointIdsOf(items)).toEqual([1, 2]);
  });

  it('has no layout before the image is there', () => {
    expect(stageGeometry(canvas, null, home, plain)).toEqual({ layout: null, transform: null });
    const { layout: shown, transform } = stageGeometry(canvas, image, home, plain);
    expect(shown).toEqual(layout);
    expect(transform).toMatchObject({ drawX: layout.drawX, flipY: false, zoom: 1 });
  });

  it('draws at the device pixel ratio, at most 4 backing pixels per canvas unit', () => {
    expect(pixelRatioFor(0.5, 2)).toBe(1);
    expect(pixelRatioFor(1, undefined)).toBe(1);
    expect(pixelRatioFor(3, 2)).toBe(4);
  });
});

describe('cut points', () => {
  it('keeps those with an id and a place', () => {
    expect(
      cutItemsOf([
        { id: 1, nx: 0.1, ny: 0.2, nx_end: 0.3, ny_end: 0.4 },
        { id: 'x', nx: 0.1, ny: 0.1 },
        { id: 3, nx: 0.5 },
        { id: 4, nx: 0.5, ny: 0.5 },
      ]),
    ).toEqual([
      { id: 1, start: [0.1, 0.2], end: [0.3, 0.4] },
      { id: 4, start: [0.5, 0.5], end: null },
    ]);
  });

  it('inserts them with the middle of their box at the point, their shape kept', () => {
    const placed = cutPlacedAt(
      [
        { id: 1, start: [0.3, 0.6], end: null },
        { id: 2, start: [0.35, 0.55], end: [0.35, 0.65] },
      ],
      [0.5, 0.5],
    )!;
    expect(placed[0].start[0]).toBeCloseTo(0.475);
    expect(placed[0].start[1]).toBeCloseTo(0.5);
    expect(placed[1].end![1]).toBeCloseTo(0.55);
    expect(cutPlacedAt([], [0.5, 0.5])).toBeNull();
  });
});

describe('alignment and scale', () => {
  it('fills in a plan alignment, flipped by default', () => {
    expect(storedAlignment(undefined, true)).toEqual({ offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1, flipY: true });
    expect(storedAlignment({ offset_x: 4, flip_y: false }, true)).toEqual({ ...plain, offsetX: 4 });
    expect(sameAlignment(plain, { ...plain })).toBe(true);
    expect(sameAlignment(plain, { ...plain, flipY: true })).toBe(false);
  });

  it('measures two calibration points and reads typed numbers', () => {
    expect(calibrationDistance([[0, 0]])).toBeNull();
    expect(calibrationDistance([[0, 0], [3, 4]])).toBe(5);
    expect(positiveNumber('2,5')).toBe(2.5);
    expect(positiveNumber('0')).toBeNull();
    expect(positiveNumber('abc')).toBeNull();
  });
});
