import { describe, expect, it } from 'vitest';
import { parseNr } from './LocationAnlegenView';

describe('parseNr', () => {
  it('reads a number, ignoring surrounding spaces', () => {
    expect(parseNr(' 4711 ')).toBe(4711);
  });

  it('treats an empty field as "no number" (the field is optional)', () => {
    expect(parseNr('')).toBeNull();
    expect(parseNr('   ')).toBeNull();
  });

  it('marks anything but digits as invalid', () => {
    expect(parseNr('47a1')).toBeNaN();
    expect(parseNr('-5')).toBeNaN();
    expect(parseNr('4.5')).toBeNaN();
  });
});
