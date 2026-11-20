import { describe, expect, it } from 'vitest';
import { importSummary, parseNr } from './LocationAnlegenView';

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

describe('importSummary', () => {
  it('counts the rows of an export file per model - for the confirmation', () => {
    const payload = {
      data: [
        { clazz: 'ProgeoLocation', id: 1 },
        { clazz: 'ProgeoDevice', id: 2 },
        { clazz: 'ProgeoDevice', id: 3 },
      ],
    };
    expect(importSummary(payload)).toEqual({ rows: 3, summary: 'ProgeoLocation: 1, ProgeoDevice: 2' });
  });

  it('takes a plain array too - and nothing from a file without rows', () => {
    expect(importSummary([{ clazz: 'ProgeoDevice' }, {}]).rows).toBe(2);
    expect(importSummary({ models: [] })).toEqual({ rows: 0, summary: '' });
  });
});
