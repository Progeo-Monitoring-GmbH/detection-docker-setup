import { describe, expect, it } from 'vitest';
import {
  chartFrame,
  chartLayout,
  frameWeights,
  plotSensors,
  type ChartLayout,
} from './heatmapChart';
import type { Scene } from './heatmapScene';
import type { SensorHeatmapResponse } from './sensorHeatmapTypes';
import { clampFrameIndex, pickedFrameIndex } from './useHeatmapFrames';
import { planIndexOf } from './useHeatmapPlan';
import {
  guideCursorOf,
  hoverAt,
  hoveredPosition,
  sensorPosAt,
  sensorPositionsIn,
  underCursorOf,
  type Hover,
} from './useHeatmapPointer';

/** Pure parts of SensorHeatmap2D's hooks: frames, plans and the pointer. */

describe('pickedFrameIndex', () => {
  const timestamps = [100, 200, 300];
  const base = {
    timestamps,
    coupled: false,
    time: null,
    ownPick: null,
    focusTime: null,
    focusRevision: 0,
  };

  it('shows the newest frame, or the one holding focusTime', () => {
    expect(pickedFrameIndex(base)).toBe(2);
    expect(pickedFrameIndex({ ...base, focusTime: 200_000 })).toBe(1);
  });

  it('keeps the own pick for its timestamps and focus only', () => {
    const ownPick = { timestamps, focus: 0, index: 0 };
    expect(pickedFrameIndex({ ...base, ownPick })).toBe(0);
    expect(pickedFrameIndex({ ...base, ownPick, focusRevision: 1 })).toBe(2);
    expect(
      pickedFrameIndex({ ...base, ownPick, timestamps: [...timestamps] }),
    ).toBe(2);
  });

  it('follows `time` when coupled - the newest while null', () => {
    const ownPick = { timestamps, focus: 0, index: 0 };
    expect(pickedFrameIndex({ ...base, coupled: true, ownPick })).toBe(2);
    expect(pickedFrameIndex({ ...base, coupled: true, time: 100_000 })).toBe(0);
  });

  it('clamps into the frames there are', () => {
    expect(clampFrameIndex(5, 3)).toBe(2);
    expect(clampFrameIndex(-1, 3)).toBe(0);
    expect(clampFrameIndex(-1, 0)).toBe(0);
  });
});

describe('planIndexOf', () => {
  it('finds the plan by id, the first for none or an unknown one', () => {
    const plans = [{ id: 3 }, { id: 8 }];
    expect(planIndexOf(plans, 8)).toBe(1);
    expect(planIndexOf(plans, 42)).toBe(0);
    expect(planIndexOf(plans, null)).toBe(0);
    expect(planIndexOf(null, 8)).toBe(0);
  });
});

describe('pointer targets', () => {
  const IDENTITY = { scale: 1, tx: 0, ty: 0 };
  const res: SensorHeatmapResponse = {
    timestamps: [0],
    data: { '7': [100], '8': [50] },
    sensor_points: [
      { pos: 7, x: 0.5, y: 0.5, device: 3 },
      { pos: 8, x: 0.8, y: 0.5, device: 4 },
    ],
  };
  const location = {
    reference_x: 0,
    reference_y: 1000,
    meters_per_pixel: 0.01,
  };
  const imageSize = { width: 1000, height: 1000 };
  const sensors = plotSensors(res, false);
  const layout = chartLayout({
    sensors,
    resolution: 40,
    location,
    imageSize,
    fitPlan: false,
    fieldMode: false,
  }) as ChartLayout;
  const frame = chartFrame(layout, frameWeights(sensors, 0, false), {
    sigma: 'auto',
    heatReference: null,
    fieldRange: null,
  });
  const plot = {
    scene: { layout, frame } as Scene,
    view: IDENTITY,
    location,
    imageSize,
  };

  it('hovers a sensor with the plan under the cursor, and reports its device', () => {
    const { hover, device } = hoverAt(plot, 505, 495);
    expect(device).toBe(3);
    expect(hover).toMatchObject({
      kind: 'sensor',
      pos: 7,
      screen: [500, 500],
      meters: [5, 5],
    });
    const under = hover?.kind === 'sensor' ? hover.under : null;
    expect(under).toMatchObject({ kind: 'cursor', cursor: [505, 495] });
    expect(under?.meters?.[0]).toBeCloseTo(5.05);
    expect(under?.meters?.[1]).toBeCloseTo(5.05);
    expect(sensorPosAt(plot, 505, 495)).toBe(7);
  });

  it('else hovers the plan, without a device', () => {
    const { hover, device } = hoverAt(plot, 650, 500);
    expect(device).toBeNull();
    expect(hover).toMatchObject({
      kind: 'cursor',
      meters: [6.5, 5],
      cursor: [650, 500],
    });
    expect(sensorPosAt(plot, 650, 500)).toBeNull();
  });

  it('hovers nothing off the plan and the heat field', () => {
    expect(hoverAt(plot, -5000, -5000)).toEqual({ hover: null, device: null });
  });

  it('selects the sensors in a rectangle by pos', () => {
    expect(sensorPositionsIn(plot, [450, 450, 850, 550])).toEqual([7, 8]);
    expect(sensorPositionsIn(plot, [750, 450, 850, 550])).toEqual([8]);
  });
});

describe('hover parts', () => {
  const plan: Hover = {
    kind: 'cursor',
    meters: [1, 2],
    heat: 0.4,
    cursor: [10, 20],
  };
  const noMeters: Hover = { ...plan, meters: null };
  const overSensor: Hover = {
    kind: 'sensor',
    pos: 5,
    screen: [9, 9],
    meters: null,
    under: plan,
  };

  it('gives the hovered sensor and the plan under the cursor', () => {
    expect(hoveredPosition(overSensor)).toBe(5);
    expect(hoveredPosition(plan)).toBeNull();
    expect(underCursorOf(overSensor)).toBe(plan);
    expect(underCursorOf(plan)).toBe(plan);
    expect(underCursorOf(null)).toBeNull();
  });

  it('leads the guides only to a position in meters', () => {
    expect(guideCursorOf(overSensor)).toEqual([10, 20]);
    expect(guideCursorOf(noMeters)).toBeNull();
    expect(guideCursorOf({ ...overSensor, under: null })).toBeNull();
  });
});
