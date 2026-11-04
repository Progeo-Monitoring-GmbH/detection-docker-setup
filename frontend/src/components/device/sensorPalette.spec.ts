import { describe, expect, it } from 'vitest';
import { assignSlots, SENSOR_HUES, sensorStyle } from './sensorPalette';

describe('assignSlots', () => {
  it('gives new sensors the lowest free slots', () => {
    expect([...assignSlots(new Map(), [3, 10, 17])]).toEqual([
      [3, 0],
      [10, 1],
      [17, 2],
    ]);
  });

  it('keeps the slots of sensors that stay - removing one frees its slot', () => {
    const first = assignSlots(new Map(), [3, 10, 17]);
    const without = assignSlots(first, [3, 17]);
    expect(without.get(17)).toBe(2);
    // The freed slot 1 goes to the next new sensor.
    const added = assignSlots(without, [1, 3, 17]);
    expect([...added].sort((a, b) => a[0] - b[0])).toEqual([
      [1, 1],
      [3, 0],
      [17, 2],
    ]);
  });
});

describe('sensorStyle', () => {
  it('uses every hue before repeating one with another line style', () => {
    const styles = Array.from({ length: 16 }, (_, slot) => sensorStyle(slot));
    expect(styles.slice(0, 4).map((style) => style.color)).toEqual([...SENSOR_HUES]);
    expect(styles.slice(0, 4).every((style) => style.dash === 'solid')).toBe(true);
    expect(sensorStyle(4)).toEqual({ color: SENSOR_HUES[0], dash: 'dash' });
    // 16 distinct combinations.
    expect(new Set(styles.map((style) => `${style.color}:${style.dash}`)).size).toBe(16);
  });
});
