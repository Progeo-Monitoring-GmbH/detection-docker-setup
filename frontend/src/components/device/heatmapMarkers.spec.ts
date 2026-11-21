import { describe, expect, it } from 'vitest';
import type { ChartSensor } from './heatmapChart';
import {
  areaRectBox,
  canvasCursor,
  highlightIndex,
  markerIndices,
  positionIndex,
  selectedIndexSet,
} from './heatmapMarkers';

const SENSORS = [
  { pos: 4, device: 10 },
  { pos: 7, device: 11 },
  { pos: 9, device: 11 },
] as ChartSensor[];

describe('marker indices', () => {
  it('finds a sensor by its pos', () => {
    expect(positionIndex(SENSORS, 7)).toBe(1);
    expect(positionIndex(SENSORS, 99)).toBeNull();
    expect(positionIndex(SENSORS, null)).toBeNull();
    expect(positionIndex(undefined, 7)).toBeNull();
  });

  it('highlights by device first (its first sensor), else by pos', () => {
    expect(highlightIndex(SENSORS, 11, 4)).toBe(1);
    expect(highlightIndex(SENSORS, 99, 4)).toBeNull();
    expect(highlightIndex(SENSORS, null, 9)).toBe(2);
    expect(highlightIndex(SENSORS, null, null)).toBeNull();
  });

  it('collects the selected sensors', () => {
    expect([...selectedIndexSet(SENSORS, [9, 4, 42])]).toEqual([0, 2]);
    expect(selectedIndexSet(SENSORS, undefined).size).toBe(0);
    expect(selectedIndexSet(undefined, [4]).size).toBe(0);
  });

  it('gives the hovered, highlighted and focused marker', () => {
    expect(
      markerIndices(SENSORS, {
        hoveredPosition: 9,
        highlightedDevice: 10,
        highlightedPosition: null,
        focusedPosition: 7,
      }),
    ).toEqual({ hovered: 2, highlighted: 0, focused: 1 });
  });
});

describe('canvasCursor', () => {
  it('selects areas, points at sensors, else grabs the plan', () => {
    expect(
      canvasCursor({ areaMode: true, overSensor: true, grabbing: true }),
    ).toBe('crosshair');
    expect(
      canvasCursor({ areaMode: false, overSensor: true, grabbing: true }),
    ).toBe('pointer');
    expect(
      canvasCursor({ areaMode: false, overSensor: false, grabbing: true }),
    ).toBe('grabbing');
    expect(
      canvasCursor({ areaMode: false, overSensor: false, grabbing: false }),
    ).toBe('grab');
  });
});

describe('areaRectBox', () => {
  it('spans the dragged rectangle from any corner', () => {
    const box = { left: 10, top: 20, width: 30, height: 40 };
    expect(areaRectBox([10, 20, 40, 60])).toEqual(box);
    expect(areaRectBox([40, 60, 10, 20])).toEqual(box);
    expect(areaRectBox([40, 20, 10, 60])).toEqual(box);
  });
});
