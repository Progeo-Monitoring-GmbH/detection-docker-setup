import { describe, expect, it } from 'vitest';
import {
  canvasHeightFor,
  chartFrame,
  chartLayout,
  COLORBAR_SPACE,
  computeAutoSigma,
  frameWeights,
  heatReference,
  hoverTarget,
  isOverDrawn,
  locationThreshold,
  planLocation,
  plotSensors,
  type ChartLayout,
} from './heatmapChart';
import type { SensorHeatmapPoint, SensorHeatmapResponse } from './sensorHeatmapTypes';

const IDENTITY = { scale: 1, tx: 0, ty: 0 };

const response = (
  points: Array<Partial<SensorHeatmapPoint> & { pos: number }>,
  data: SensorHeatmapResponse['data'],
): SensorHeatmapResponse => ({
  timestamps: [0, 60],
  data,
  sensor_points: points.map((point) => ({ x: 0.5, y: 0.5, ...point })),
});

const layoutOf = (
  res: SensorHeatmapResponse,
  options: Partial<Parameters<typeof chartLayout>[0]> = {},
) =>
  chartLayout({
    sensors: plotSensors(res, false),
    resolution: 40,
    location: null,
    imageSize: null,
    fitPlan: false,
    fieldMode: false,
    ...options,
  }) as ChartLayout;

describe('thresholds', () => {
  it('only takes a positive alarm threshold, saturating at three times it', () => {
    expect(locationThreshold({ alarm_threshold: 200 })).toBe(200);
    expect(heatReference({ alarm_threshold: 200 })).toBe(600);
    expect(locationThreshold({ alarm_threshold: 0 })).toBeNull();
    expect(locationThreshold({ alarm_threshold: null })).toBeNull();
    expect(heatReference(null)).toBeNull();
  });
});

describe('planLocation', () => {
  it('merges the plan url and alignment, with defaults', () => {
    const merged = planLocation(
      { id: 3, name: 'Halle', alarm_threshold: 100 },
      { id: 9, url: 'media/plan.png', scale_x: 2, flip_y: null },
    );
    expect(merged).toMatchObject({
      id: 3,
      alarm_threshold: 100,
      lageplan_url: 'media/plan.png',
      offset_x: 0,
      scale_x: 2,
      scale_y: 1,
      flip_y: false,
      reference_x: null,
    });
  });

  it('keeps the location without a plan', () => {
    const base = { id: 3 };
    expect(planLocation(base, null)).toBe(base);
  });
});

describe('plotSensors', () => {
  it('mirrors y (ny = 0 is the top), unless the plan is flipped', () => {
    const res = response([{ pos: 1, x: 0.2, y: 0.1, threshold: 50, name: 'A' }], { '1': [1, 2] });
    expect(plotSensors(res, false)[0]).toMatchObject({ pos: 1, x: 0.2, y: 0.9, nx: 0.2, ny: 0.1, threshold: 50 });
    expect(plotSensors(res, true)[0].y).toBe(0.1);
    expect(plotSensors(res, false)[0].series).toEqual([1, 2]);
  });

  it('drops points without a position', () => {
    const res = response([{ pos: 1, x: Number.NaN }, { pos: 2 }], {});
    expect(plotSensors(res, false).map((sensor) => sensor.pos)).toEqual([2]);
  });

  it('lays out unplaced sensors with data on a grid', () => {
    const sensors = plotSensors({ timestamps: [], data: { '2': [1], '1': [2], '3': [3], '4': [4] } }, false);
    expect(sensors.map(({ pos, x, y, nx }) => [pos, x, y, nx])).toEqual([
      [1, 0, 1, null],
      [2, 1, 1, null],
      [3, 0, 0, null],
      [4, 1, 0, null],
    ]);
  });
});

describe('computeAutoSigma', () => {
  it('follows the median neighbour distance, within limits', () => {
    expect(computeAutoSigma([])).toBe(0.05);
    expect(computeAutoSigma([{ x: 0, y: 0 }])).toBe(0.05);
    expect(computeAutoSigma([{ x: 0, y: 0 }, { x: 0.05, y: 0 }])).toBeCloseTo(0.0575);
    expect(computeAutoSigma([{ x: 0, y: 0 }, { x: 1, y: 0 }])).toBe(0.12);
    expect(computeAutoSigma([{ x: 0, y: 0 }, { x: 0.001, y: 0 }])).toBe(0.008);
  });
});

describe('chartLayout', () => {
  const res = response(
    [
      { pos: 1, x: 0.25, y: 0.25 },
      { pos: 2, x: 0.75, y: 0.5, threshold: 80 },
    ],
    { '1': [10, 20], '2': [30, 40] },
  );

  it('is null without sensors', () => {
    expect(chartLayout({ ...layoutOf(res), sensors: [], location: null, imageSize: null, fitPlan: false, fieldMode: false })).toBeNull();
  });

  it('places the sensors on a stand-in square without an image', () => {
    const layout = layoutOf(res, { location: { alarm_threshold: 100 } });
    expect(layout.world).toEqual({ width: 1000, height: 1000 });
    expect(layout.sensors.map(({ wx, wy }) => [wx, wy])).toEqual([
      [250, 250],
      [750, 500],
    ]);
    // Own threshold, else the location's.
    expect(layout.sensors.map((sensor) => sensor.threshold)).toEqual([100, 80]);
    expect(layout.reference).toBeNull();
  });

  it('places the sensors on the image pixels and keeps the calibrated reference', () => {
    const location = { reference_x: 100, reference_y: 900, meters_per_pixel: 0.01 };
    const layout = layoutOf(res, { location, imageSize: { width: 2000, height: 1000 } });
    expect(layout.sensors[0]).toMatchObject({ wx: 500, wy: 250 });
    expect(layout.reference).toEqual([100, 900]);
    expect(layout.bounds.left).toBeLessThan(100);
    expect(layout.bounds.bottom).toBeGreaterThan(900);
  });

  it('views the heat field (sensors plus border) with a 2% margin', () => {
    // A plan scaled down to its left half: the field covers that half only.
    const { bounds, heatRect } = layoutOf(res, {
      location: { scale_x: 0.5 },
      imageSize: { width: 1000, height: 1000 },
    });
    expect(heatRect.right).toBeLessThan(1000);
    expect(bounds).toEqual({
      left: heatRect.left - 20,
      right: heatRect.right + 20,
      top: heatRect.top - 20,
      bottom: heatRect.bottom + 20,
    });
  });

  it('fits the whole plan with fitPlan', () => {
    const { bounds } = layoutOf(res, { imageSize: { width: 1000, height: 1000 }, fitPlan: true });
    expect(bounds.left).toBeCloseTo(-5);
    expect(bounds.right).toBeCloseTo(1005);
  });

  it('has no thresholds in field mode', () => {
    const layout = layoutOf(res, { location: { alarm_threshold: 100 }, fieldMode: true });
    expect(layout.sensors.map((sensor) => sensor.threshold)).toEqual([null, null]);
  });
});

describe('frameWeights / chartFrame', () => {
  const res = response(
    [
      { pos: 1, x: 0.3, y: 0.5 },
      { pos: 2, x: 0.7, y: 0.5 },
    ],
    { '1': [-5, null], '2': [20, 40] },
  );
  const sensors = plotSensors(res, false);

  it('weighs heat by magnitude (0 without a reading), fields by the reading', () => {
    expect(frameWeights(sensors, 0, false).map((point) => point.weight)).toEqual([5, 20]);
    expect(frameWeights(sensors, 1, false).map((point) => point.weight)).toEqual([0, 40]);
    expect(frameWeights(sensors, 0, true).map((point) => point.weight)).toEqual([-5, 20]);
    expect(frameWeights(sensors, 1, true)[0].weight).toBeNaN();
  });

  it('builds the heat field on the layout grid', () => {
    const layout = layoutOf(res);
    const frame = chartFrame(layout, frameWeights(sensors, 1, false), {
      sigma: 'auto',
      heatReference: null,
      fieldRange: null,
    });
    expect(frame.grid).toHaveLength(40);
    expect(frame.coverage).toBeNull();
    expect(frame.values).toEqual([0, 40]);
    // Relative scaling: the hottest cell is 1.
    expect(Math.max(...frame.grid.map((row) => Math.max(...row)))).toBeCloseTo(1);
  });

  it('interpolates a field with coverage', () => {
    const layout = layoutOf(res);
    const frame = chartFrame(layout, frameWeights(sensors, 0, true), {
      sigma: 0.05,
      heatReference: null,
      fieldRange: { min: -5, max: 20 },
    });
    expect(frame.coverage).toHaveLength(40);
    expect(frame.values).toEqual([-5, 20]);
  });
});

describe('canvasHeightFor', () => {
  const wide = { left: 0, top: 0, right: 2000, bottom: 500 };
  const tall = { left: 0, top: 0, right: 500, bottom: 2000 };

  it('keeps the aspect ratio, within 160 and the height', () => {
    expect(canvasHeightFor(wide, 800 + COLORBAR_SPACE, 600, false)).toBe(200);
    expect(canvasHeightFor(tall, 800 + COLORBAR_SPACE, 600, false)).toBe(600);
    expect(canvasHeightFor({ ...wide, right: 20000 }, 800 + COLORBAR_SPACE, 600, false)).toBe(160);
  });

  it('lets a tall plan grow with fitPlan', () => {
    expect(canvasHeightFor(tall, 800 + COLORBAR_SPACE, 600, true)).toBe(1600);
  });

  it('falls back to the height before measuring', () => {
    expect(canvasHeightFor(null, 800, 600, false)).toBe(600);
    expect(canvasHeightFor(wide, 0, 600, false)).toBe(600);
  });
});

describe('isOverDrawn / hoverTarget', () => {
  const res = response([{ pos: 7, x: 0.5, y: 0.5, device: 3 }], { '7': [100, 200] });
  const location = { reference_x: 0, reference_y: 1000, meters_per_pixel: 0.01 };
  const imageSize = { width: 1000, height: 1000 };
  const layout = layoutOf(res, { location, imageSize });
  const frame = chartFrame(layout, frameWeights(plotSensors(res, false), 0, false), {
    sigma: 'auto',
    heatReference: null,
    fieldRange: null,
  });

  it('zooms with the wheel only over the drawn plan', () => {
    // The heat field reaches beyond the plan (to 1150 here).
    expect(isOverDrawn(layout, IDENTITY, true, 10, 10)).toBe(true);
    expect(isOverDrawn(layout, IDENTITY, true, 1100, 500)).toBe(false);
    // Without an image, over the heat field.
    expect(isOverDrawn(layout, IDENTITY, false, 1100, 500)).toBe(true);
    expect(isOverDrawn(layout, IDENTITY, false, 1200, 500)).toBe(false);
  });

  it('finds the sensor under the cursor', () => {
    expect(hoverTarget(layout, frame, IDENTITY, location, imageSize, 505, 495)).toEqual({
      kind: 'sensor',
      index: 0,
      screen: [500, 500],
      meters: [5, 5],
    });
  });

  it('else gives the position in meters and the heat', () => {
    const target = hoverTarget(layout, frame, IDENTITY, location, imageSize, 600, 500);
    expect(target?.kind).toBe('cursor');
    expect(target).toMatchObject({ meters: [6, 5] });
    expect(target?.kind === 'cursor' && target.heat).toBeGreaterThan(0);
  });

  it('is null off the plan and the heat field', () => {
    expect(hoverTarget(layout, frame, IDENTITY, location, imageSize, -5000, -5000)).toBeNull();
  });
});
