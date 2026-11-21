import type { TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';
import { DISABLED_SENSOR_FILL } from '../components/device/disabledSensors';
import { type MixerSensor, NO_DRAFTS, type ThresholdDrafts } from './thresholdMixer';
import {
  BAR,
  BAR_OVER,
  barFillOf,
  bulkNumberOf,
  changeTextOf,
  clickedBarOf,
  clickedMarkerOf,
  cursorOf,
  formatValue,
  grabOf,
  gridOf,
  keyScrollOf,
  liveScaleOf,
  type MixerState,
  mixerCountsOf,
  nudgedValue,
  onBarOf,
  overOrdersOf,
  type Press,
  patchedSensors,
  prunedPatch,
  quietOrdersOf,
  scrollViewOf,
  selectionFlagsOf,
  sensorLabelOf,
  stillAClick,
  toggledIn,
  visibleColumnsOf,
  withSavedPoints,
  withToggledDisabled,
  yAxisOf,
} from './thresholdMixerView';

const sensor = (order: number, threshold: number | null, max: number | null, disabled = false): MixerSensor => ({
  sensor_order: order,
  id: null,
  name: null,
  threshold,
  max,
  ...(disabled ? { disabled: true } : {}),
});

// Object 100: 1 plain, 2 over its own 150, 3 inherits, 4 protected by its own 150, 5 quiet.
const SENSORS = [sensor(1, null, 50), sensor(2, 150, 200), sensor(3, null, 80), sensor(4, 150, 120), sensor(5, null, 3)];
const state = (drafts: ThresholdDrafts = NO_DRAFTS, selected: number[] = []): MixerState => ({
  drafts,
  savedObject: 100,
  selected: new Set(selected),
});
const t = ((key: string, options?: Record<string, unknown>) =>
  options ? `${key}:${JSON.stringify(options)}` : key) as unknown as TFunction;

describe('scale and axis', () => {
  it('reaches 15 % over the highest maximum or threshold, at least 1', () => {
    expect(liveScaleOf(SENSORS, 100, NO_DRAFTS)).toBeCloseTo(230);
    expect(liveScaleOf(SENSORS, 300, NO_DRAFTS)).toBeCloseTo(345);
    expect(liveScaleOf([], null, NO_DRAFTS)).toBeCloseTo(1.15);
  });

  it('maps values to y and back, snapped, clipped at the top', () => {
    const { step, toY, valueAt } = yAxisOf(230);
    expect(step).toBe(2);
    expect(toY(0)).toBe(240);
    expect(toY(100)).toBe(140);
    expect(toY(1000)).toBe(10);
    expect(valueAt(116)).toBe(124);
    expect(valueAt(300)).toBe(0);
  });

  it('draws grid lines at round values within the scale', () => {
    expect(gridOf(liveScaleOf(SENSORS, 100, NO_DRAFTS))).toEqual([0, 50, 100, 150, 200]);
    expect(gridOf(10).every((value) => value <= 10)).toBe(true);
  });

  it('formats values to one decimal', () => {
    expect(formatValue(null)).toBe('–');
    expect(formatValue(12.345)).toBe('12.3');
  });
});

describe('columns and counts', () => {
  it('hides the quiet sensors on request - except changed or selected ones', () => {
    const quiet = quietOrdersOf(SENSORS, 100);
    expect([...quiet]).toEqual([5]);
    expect(visibleColumnsOf(SENSORS, false, quiet, state())).toBe(SENSORS);
    expect(visibleColumnsOf(SENSORS, true, quiet, state()).map((s) => s.sensor_order)).toEqual([1, 2, 3, 4]);
    expect(visibleColumnsOf(SENSORS, true, quiet, state(NO_DRAFTS, [5]))).toHaveLength(5);
    expect(visibleColumnsOf(SENSORS, true, quiet, state({ sensors: { 5: 20 } }))).toHaveLength(5);
  });

  it('counts over, own and disabled sensors', () => {
    expect(mixerCountsOf(SENSORS, 100, NO_DRAFTS)).toEqual({ over: 1, own: 2, disabled: 0 });
    expect(mixerCountsOf(SENSORS, 100, { sensors: {}, disabled: { 2: true } })).toEqual({ over: 0, own: 2, disabled: 1 });
    expect(overOrdersOf(SENSORS, 40, NO_DRAFTS)).toEqual([1, 2, 3]);
  });

  it('says what the selection tools can do', () => {
    expect(selectionFlagsOf(SENSORS, new Set([1, 3]), NO_DRAFTS)).toEqual({
      anyOwn: false,
      anyEnabled: true,
      anyDisabled: false,
    });
    expect(selectionFlagsOf([sensor(2, 150, 200, true)], new Set([2]), NO_DRAFTS)).toEqual({
      anyOwn: true,
      anyEnabled: false,
      anyDisabled: true,
    });
  });

  it('accepts only numbers ≥ 0 as the bulk value', () => {
    expect(bulkNumberOf('')).toBeNull();
    expect(bulkNumberOf('  ')).toBeNull();
    expect(bulkNumberOf('-1')).toBeNull();
    expect(bulkNumberOf('abc')).toBeNull();
    expect(bulkNumberOf('0')).toBe(0);
    expect(bulkNumberOf('12.5')).toBe(12.5);
  });

  it('fills bars grey, red, striped or plain', () => {
    const plain = state();
    expect(barFillOf(SENSORS[0], plain, 'x')).toBe(BAR);
    expect(barFillOf(SENSORS[1], plain, 'x')).toBe(BAR_OVER);
    expect(barFillOf(SENSORS[3], plain, 'x')).toBe('url(#x)');
    expect(barFillOf(sensor(2, 150, 200, true), plain, 'x')).toBe(DISABLED_SENSOR_FILL);
  });
});

describe('pointer', () => {
  const { toY } = yAxisOf(230);

  it('grabs an own marker first, as a click candidate', () => {
    expect(grabOf(SENSORS[1], 95, state(), 100, toY)).toEqual({ kind: 'sensors', orders: [2], clicked: 2 });
    expect(grabOf(SENSORS[1], 70, state(), 100, toY)).toBeNull();
  });

  it('grabs the whole selection at a selected sensor\'s spot on the object line', () => {
    expect(grabOf(SENSORS[0], 140, state(NO_DRAFTS, [1, 3]), 100, toY)).toEqual({ kind: 'sensors', orders: [1, 3] });
  });

  it('grabs the object line elsewhere - also right of the last sensor', () => {
    expect(grabOf(SENSORS[2], 135, state(), 100, toY)).toEqual({ kind: 'object' });
    expect(grabOf(null, 145, state(), 100, toY)).toEqual({ kind: 'object' });
    expect(grabOf(null, 145, state(), null, toY)).toBeNull();
  });

  it('keeps a press a click until it moves CLICK_PX', () => {
    const press: Press = { y: 100, moved: false };
    expect(stillAClick(press, 102)).toBe(true);
    expect(press.moved).toBe(false);
    expect(stillAClick(press, 110)).toBe(false);
    expect(press.moved).toBe(true);
    expect(stillAClick(press, 100)).toBe(false);
    expect(stillAClick(null, 100)).toBe(false);
  });

  it('removes a clicked own marker only if the press did not move', () => {
    const drag = { kind: 'sensors' as const, orders: [2], clicked: 2 };
    expect(clickedMarkerOf(drag, { y: 0, moved: false })).toBe(2);
    expect(clickedMarkerOf(drag, { y: 0, moved: true })).toBeNull();
    expect(clickedMarkerOf({ kind: 'sensors', orders: [2] }, { y: 0, moved: false })).toBeNull();
    expect(clickedMarkerOf({ kind: 'object' }, null)).toBeNull();
    expect(clickedMarkerOf(null, null)).toBeNull();
  });

  it('picks the cursor', () => {
    expect(cursorOf(true, true, 'column')).toBe('ns-resize');
    expect(cursorOf(false, true, 'column')).toBe('crosshair');
    expect(cursorOf(false, true, 'bar')).toBe('pointer');
    expect(cursorOf(false, true, null)).toBe('default');
    expect(cursorOf(false, false, 'bar')).toBe('default');
  });

  it('finds the bar under the pointer - a thin one with some slack', () => {
    // Sensor 3: max 80 -> bar from y 160 down to the base line at 240.
    expect(onBarOf(SENSORS[2], 200, toY)).toBe(true);
    expect(onBarOf(SENSORS[2], 158, toY)).toBe(true);
    expect(onBarOf(SENSORS[2], 150, toY)).toBe(false);
    expect(onBarOf(SENSORS[2], 250, toY)).toBe(false);
    expect(onBarOf(sensor(9, null, null), 239, toY)).toBe(false);
  });

  it('toggles a bar only on a click, not a drag', () => {
    const drag = { kind: 'sensors' as const, orders: [3], toggles: 3 };
    expect(clickedBarOf(drag, { y: 0, moved: false })).toBe(3);
    expect(clickedBarOf(drag, { y: 0, moved: true })).toBeNull();
    expect(clickedBarOf({ kind: 'sensors', orders: [3] }, { y: 0, moved: false })).toBeNull();
    expect(clickedBarOf({ kind: 'object' }, { y: 0, moved: false })).toBeNull();
  });

  it('switches a sensor off - or on again', () => {
    const off = withToggledDisabled(NO_DRAFTS, SENSORS[2]);
    expect(off.disabled).toEqual({ 3: true });
    expect(withToggledDisabled(off, SENSORS[2]).disabled).toEqual({ 3: false });
    expect(withToggledDisabled(NO_DRAFTS, sensor(3, null, 80, true)).disabled).toEqual({ 3: false });
  });

  it('nudges with ↑/↓ (Shift: ten steps), never below 0', () => {
    expect(nudgedValue('ArrowUp', false, 100, 2)).toBe(102);
    expect(nudgedValue('ArrowDown', true, 100, 2)).toBe(80);
    expect(nudgedValue('ArrowDown', false, null, 2)).toBe(0);
    expect(nudgedValue('Enter', false, 100, 2)).toBeUndefined();
  });

  it('scrolls with ←/→ by five columns, Shift: 90 % of the view', () => {
    expect(keyScrollOf('ArrowRight', false, 800, 64)).toBe(320);
    expect(keyScrollOf('ArrowLeft', false, 800, 64)).toBe(-320);
    expect(keyScrollOf('ArrowRight', true, 800, 64)).toBe(720);
    expect(keyScrollOf('ArrowUp', false, 800, 64)).toBeNull();
  });

  it('toggles a sensor in or out of a set', () => {
    expect([...toggledIn(new Set([1, 2]), 2)]).toEqual([1]);
    expect([...toggledIn(new Set([1]), 3)]).toEqual([1, 3]);
  });
});

describe('scroll view', () => {
  it('says which columns are shown and where the edges are', () => {
    expect(scrollViewOf({ left: 0, client: 800, total: 800 }, 64, 10)).toEqual({
      scrollable: false,
      atStart: true,
      atEnd: true,
      firstShown: 1,
      lastShown: 10,
    });
    expect(scrollViewOf({ left: 640, client: 640, total: 3200 }, 64, 50)).toEqual({
      scrollable: true,
      atStart: false,
      atEnd: false,
      firstShown: 11,
      lastShown: 20,
    });
  });
});

describe('saved patch', () => {
  it('patches the saved values in and drops them once the data has them', () => {
    const patch = withSavedPoints({}, [{ sensor_order: 2, threshold: 180 }, { sensor_order: 3, disabled: true }]);
    expect(patch).toEqual({ 2: { threshold: 180 }, 3: { disabled: true } });
    expect(patchedSensors(SENSORS, patch)[1].threshold).toBe(180);
    expect(patchedSensors(SENSORS, patch)[2].disabled).toBe(true);
    expect(prunedPatch(patch, SENSORS)).toBe(patch);
    const reloaded = [sensor(2, 180, 200), sensor(3, null, 80)];
    expect(prunedPatch(patch, reloaded)).toEqual({ 3: { disabled: true } });
  });

  it('merges a second save into the patch', () => {
    expect(withSavedPoints({ 2: { threshold: 180 } }, [{ sensor_order: 2, disabled: true }])).toEqual({
      2: { threshold: 180, disabled: true },
    });
  });
});

describe('texts', () => {
  it('names a sensor - or numbers it', () => {
    const named = [{ ...SENSORS[1], name: 'Dach' }];
    expect(sensorLabelOf(named, 2, t)).toBe('Dach');
    expect(sensorLabelOf(named, 9, t)).toBe('einstell_points_sensor:{"sensor":9}');
  });

  it('reads a change as from → to', () => {
    expect(changeTextOf({ key: 'object', kind: 'object', from: 100, to: 124 }, 124, t)).toBe('100 mV → 124 mV');
    expect(changeTextOf({ key: 'object', kind: 'object', from: null, to: 50 }, 50, t)).toBe(
      'einstell_mixer_none → 50 mV',
    );
    expect(changeTextOf({ key: 'sensor-2', kind: 'sensor', sensorOrder: 2, from: 150, to: null }, 100, t)).toBe(
      '150 mV → einstell_mixer_inherits:{"value":"100"}',
    );
    expect(changeTextOf({ key: 'disabled-2', kind: 'disabled', sensorOrder: 2, from: false, to: true }, 100, t)).toBe(
      'einstell_mixer_change_disabled',
    );
    expect(changeTextOf({ key: 'disabled-2', kind: 'disabled', sensorOrder: 2, from: true, to: false }, 100, t)).toBe(
      'einstell_mixer_change_enabled',
    );
  });
});
