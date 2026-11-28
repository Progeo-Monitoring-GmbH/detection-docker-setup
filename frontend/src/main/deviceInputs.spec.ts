import { describe, expect, it } from 'vitest';
import {
  coverage,
  draftsFrom,
  inputRuns,
  isDirty,
  isLinear,
  numberRanges,
  savePayload,
  segmentsOf,
  withInputCount,
  withRun,
  type InputsDraft,
} from './deviceInputs';

/** Inputs 1-16 -> 1-16, 17 free, 18-20 -> 17-19, 21-22 -> 569-570 (a late band). */
const INPUTS = [...Array.from({ length: 16 }, (_, index) => index + 1), null, 17, 18, 19, 569, 570];
const draft = (inputs: (number | null)[], deviceId = 1): InputsDraft => ({
  deviceId,
  label: `7025-0${deviceId}`,
  inputs,
  edited: [],
});

describe('the sections of a device', () => {
  it('runs counting on, a free gap and a jump', () => {
    expect(segmentsOf(INPUTS)).toEqual([
      { from: 1, to: 16, start: 1, end: 16, direction: 'up', kind: 'count' },
      { from: 17, to: 17, start: null, end: null, direction: 'up', kind: 'free' },
      // After a free input the count goes on from the sensor before it.
      { from: 18, to: 20, start: 17, end: 19, direction: 'up', kind: 'count' },
      { from: 21, to: 22, start: 569, end: 570, direction: 'up', kind: 'jump' },
    ]);
  });

  it('a descending run and free inputs at the end', () => {
    expect(segmentsOf([10, 9, 8, null, null])).toEqual([
      { from: 1, to: 3, start: 10, end: 8, direction: 'down', kind: 'count' },
      { from: 4, to: 5, start: null, end: null, direction: 'up', kind: 'free' },
    ]);
    expect(inputRuns([5, 6, 4, 3])).toEqual([
      { from: 1, to: 2, start: 5, end: 6 },
      { from: 3, to: 4, start: 4, end: 3 },
    ]);
  });

  it('is linear only from input 1 on without a free input', () => {
    expect(isLinear([289, 290, 291])).toBe(true);
    expect(isLinear(INPUTS)).toBe(false);
    expect(isLinear([])).toBe(false);
  });
});

describe('editing', () => {
  it('sets a section up or down, beyond the inputs too, and marks it edited', () => {
    const next = withRun(draft([1, 2, 3]), 3, 5, 20, 'down');
    expect(next.inputs).toEqual([1, 2, 20, 19, 18]);
    expect(next.edited).toEqual([3, 4, 5]);
    expect(withRun(next, 1, 2, null).inputs).toEqual([null, null, 20, 19, 18]);
    // No sensor below 1.
    expect(withRun(draft([5]), 1, 3, 2, 'down').inputs).toEqual([2, 1, null]);
  });

  it('changes the number of inputs', () => {
    expect(withInputCount({ ...draft([1, 2, 3]), edited: [3] }, 2)).toEqual({ ...draft([1, 2]), edited: [] });
    expect(withInputCount(draft([1]), 3).inputs).toEqual([1, null, null]);
  });
});

describe('coverage and saving', () => {
  it('names the points no input measures and the sensors on two inputs', () => {
    const drafts = [draft([1, 2, 3]), draft([3, 4], 2)];
    expect(coverage(drafts, [1, 2, 3, 4, 5, 9])).toEqual({ missing: [5, 9], doubled: [3], measured: 4 });
    expect(numberRanges([9, 5, 6, 7, 1])).toBe('1, 5–7, 9');
  });

  it('is dirty once a device differs from the answer', () => {
    const answer = {
      sensors: [1, 2],
      devices: [{
        device_id: 1, label: '7025-01', hardware: 'smartex dm', first_sensor_order: 1, sensor_count: 2,
        measured_inputs: 2, mapped: false,
        inputs: [
          { position: 1, sensor_order: 1, source: 'formula' as const },
          { position: 2, sensor_order: 2, source: 'formula' as const },
        ],
      }],
    };
    const drafts = draftsFrom(answer);
    expect(drafts).toEqual([draft([1, 2])]);
    expect(isDirty(drafts, answer)).toBe(false);
    expect(isDirty([withRun(drafts[0], 2, 2, null)], answer)).toBe(true);
    expect(savePayload(7, [withRun(drafts[0], 2, 2, null)])).toEqual({
      location_id: 7,
      devices: [{ device_id: 1, inputs: [1, null], edited: [2] }],
    });
  });
});
