import { describe, expect, it } from 'vitest';
import {
  effectiveThresholdOf,
  isOver,
  labelEveryOf,
  type MixerSensor,
  NO_DRAFTS,
  rangeBetween,
  savePayloadOf,
  snapped,
  snapStepOf,
  thresholdChanges,
  withOverrides,
  withoutChange,
} from './thresholdMixer';

const sensor = (order: number, threshold: number | null = null, max: number | null = null): MixerSensor => ({
  sensor_order: order,
  id: threshold == null ? null : order * 10,
  name: null,
  threshold,
  max,
});

describe('effective threshold', () => {
  it('is the override, else the object threshold - drafts first', () => {
    const own = sensor(1, 150, 120);
    const inherits = sensor(2, null, 120);
    expect(effectiveThresholdOf(own, 100, NO_DRAFTS)).toBe(150);
    expect(effectiveThresholdOf(inherits, 100, NO_DRAFTS)).toBe(100);
    expect(effectiveThresholdOf(inherits, 100, { object: 130, sensors: {} })).toBe(130);
    expect(effectiveThresholdOf(own, 100, { sensors: { 1: null } })).toBe(100);
    expect(isOver(inherits, 100, NO_DRAFTS)).toBe(true);
    expect(isOver(own, 100, NO_DRAFTS)).toBe(false);
    expect(isOver(sensor(3), 100, NO_DRAFTS)).toBe(false);
  });
});

describe('thresholdChanges', () => {
  const sensors = [sensor(1, 150), sensor(2), sensor(3)];

  it('is empty without drafts and for drafts that change nothing', () => {
    expect(thresholdChanges(sensors, 100, NO_DRAFTS)).toEqual([]);
    expect(thresholdChanges(sensors, 100, { object: 100, sensors: { 1: 150, 2: null } })).toEqual([]);
  });

  it('lists the object and every changed sensor - set, moved and removed', () => {
    const changes = thresholdChanges(sensors, 100, { object: 120, sensors: { 1: null, 2: 80 } });
    expect(changes).toEqual([
      { key: 'object', kind: 'object', from: 100, to: 120 },
      { key: 'sensor-1', kind: 'sensor', sensorOrder: 1, from: 150, to: null },
      { key: 'sensor-2', kind: 'sensor', sensorOrder: 2, from: null, to: 80 },
    ]);
  });

  it('stores no override that equals the object threshold of an inheriting sensor', () => {
    expect(thresholdChanges(sensors, 100, { sensors: { 3: 100 } })).toEqual([]);
    expect(thresholdChanges(sensors, 100, { object: 90, sensors: { 3: 90 } })).toHaveLength(1);
    // An existing override set to the object value stays an override.
    expect(thresholdChanges(sensors, 150, { sensors: { 1: 150 } })).toEqual([]);
  });
});

describe('editing drafts', () => {
  it('sets or removes many overrides at once and undoes single changes', () => {
    const drafts = withOverrides({ object: 120, sensors: {} }, [1, 2], 90);
    expect(drafts).toEqual({ object: 120, sensors: { 1: 90, 2: 90 } });
    expect(withOverrides(drafts, [2], null).sensors).toEqual({ 1: 90, 2: null });
    const sensorUndo = withoutChange(drafts, { key: 'sensor-1', kind: 'sensor', sensorOrder: 1, from: null, to: 90 });
    expect(sensorUndo).toEqual({ object: 120, sensors: { 2: 90 } });
    expect(withoutChange(drafts, { key: 'object', kind: 'object', from: 100, to: 120 })).toEqual({
      sensors: { 1: 90, 2: 90 },
    });
  });

  it('builds the requests from the changes only', () => {
    expect(
      savePayloadOf([
        { key: 'object', kind: 'object', from: 100, to: 120 },
        { key: 'sensor-4', kind: 'sensor', sensorOrder: 4, from: 80, to: null },
      ]),
    ).toEqual({ object: { alarm_threshold: 120 }, points: [{ sensor_order: 4, threshold: null }] });
    expect(savePayloadOf([])).toEqual({ object: null, points: [] });
  });
});

describe('snapping and axis', () => {
  it('snaps to a round step of about 1/200 of the scale', () => {
    expect(snapStepOf(700)).toBe(5);
    expect(snapStepOf(150)).toBe(1);
    expect(snapStepOf(30)).toBe(0.2);
    expect(snapped(123.4, 5)).toBe(125);
    expect(snapped(0.31, 0.2)).toBe(0.4);
    expect(snapped(-12, 5)).toBe(0);
  });

  it('labels about every 40 px', () => {
    expect(labelEveryOf(64)).toBe(1);
    expect(labelEveryOf(14)).toBe(5);
    expect(labelEveryOf(3)).toBe(20);
  });

  it('selects a range in plot order (Shift+click)', () => {
    expect(rangeBetween([1, 2, 3, 5, 8], 8, 2)).toEqual([2, 3, 5, 8]);
    expect(rangeBetween([1, 2], 9, 2)).toEqual([2]);
  });
});
