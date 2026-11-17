import { describe, expect, it } from 'vitest';
import { addedSensor, focusedPositionOf } from './analyseFocus';

describe('addedSensor', () => {
  it('is the one sensor added', () => {
    expect(addedSensor([1, 3], [1, 2, 3])).toBe(2);
    expect(addedSensor([], [4])).toBe(4);
  });

  it('is null when none or several are added', () => {
    expect(addedSensor([1, 2], [1])).toBeNull();
    expect(addedSensor([1], [1])).toBeNull();
    expect(addedSensor([], [1, 2])).toBeNull();
  });
});

describe('focusedPositionOf', () => {
  const points = [
    { pos: 1, device: 10, pair: 1 },
    { pos: 2, device: 10, pair: 2 },
    { pos: 3, device: 20, pair: 1 },
  ];

  it('maps the focused pair of the shown device to its plan position', () => {
    expect(focusedPositionOf(points, { device: 10, pair: 1 }, [0, 1], 10)).toBe(
      2,
    );
    expect(focusedPositionOf(points, { device: 20, pair: 0 }, [0], 20)).toBe(3);
  });

  it('is null when the focused sensor is no longer active', () => {
    expect(
      focusedPositionOf(points, { device: 10, pair: 1 }, [0], 10),
    ).toBeNull();
    expect(focusedPositionOf(points, null, [0], 10)).toBeNull();
  });

  it('is null for a focus on another device than the shown one', () => {
    expect(
      focusedPositionOf(points, { device: 20, pair: 0 }, [0], 10),
    ).toBeNull();
  });

  it('counts by pos without pair numbers (one device)', () => {
    expect(
      focusedPositionOf(
        [{ pos: 5 }, { pos: 6 }],
        { device: null, pair: 5 },
        [5],
        null,
      ),
    ).toBe(6);
  });
});
