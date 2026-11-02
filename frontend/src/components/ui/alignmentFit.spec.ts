import { describe, expect, it } from 'vitest';
import { fitAlignment, placeWith, type AlignPin } from './alignmentFit';

const WIDTH = 5000;
const HEIGHT = 4000;
const BASE = 0.142;

/** Pins of sensors placed exactly by `alignment`. */
const pinsFor = (alignment: Parameters<typeof placeWith>[1], sources: Array<[number, number]>): AlignPin[] =>
  sources.map((source) => ({ source, target: placeWith(source, alignment, WIDTH, HEIGHT, BASE) }));

const SOURCES: Array<[number, number]> = [[0.1, 0.2], [0.9, 0.25], [0.5, 0.95]];

describe('fitAlignment', () => {
  it('finds the alignment of three pins - whole-pixel offsets, scales to four decimals', () => {
    const exact = { offsetX: 17, offsetY: -4, scaleX: 0.9643, scaleY: 1.0028, flipY: false };
    const fit = fitAlignment(pinsFor(exact, SOURCES), WIDTH, HEIGHT, BASE);
    expect('alignment' in fit && fit.alignment).toMatchObject(exact);
    expect('alignment' in fit && fit.alignment.errorPx).toBeLessThan(1);
  });

  it('turns a falling y into the vertical flip', () => {
    const exact = { offsetX: 3, offsetY: 12, scaleX: 1.1, scaleY: 0.87, flipY: true };
    const fit = fitAlignment(pinsFor(exact, SOURCES), WIDTH, HEIGHT, BASE);
    expect('alignment' in fit && fit.alignment).toMatchObject(exact);
  });

  it('makes up for the whole-pixel offset with the scale', () => {
    // 17.4 canvas px is 0.4 px (14 image px here) off a whole one.
    const exact = { offsetX: 17.4, offsetY: 0, scaleX: 0.95, scaleY: 1, flipY: false };
    const fit = fitAlignment(pinsFor(exact, SOURCES), WIDTH, HEIGHT, BASE);
    expect('alignment' in fit).toBe(true);
    if ('alignment' in fit) {
      expect(fit.alignment.offsetX).toBe(17);
      expect(fit.alignment.scaleX).not.toBe(0.95);
      expect(fit.alignment.errorPx).toBeLessThan(14);
    }
  });

  it('averages slightly misplaced pins and reports how far off they are', () => {
    const exact = { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1, flipY: false };
    const pins = pinsFor(exact, [...SOURCES, [0.3, 0.6]]);
    pins[0].target = [pins[0].target[0] + 4 / WIDTH, pins[0].target[1]]; // 4 px off
    const fit = fitAlignment(pins, WIDTH, HEIGHT, BASE);
    expect('alignment' in fit).toBe(true);
    if ('alignment' in fit) {
      expect(fit.alignment.scaleX).toBeCloseTo(1, 2);
      expect(fit.alignment.errorPx).toBeGreaterThan(1);
      expect(fit.alignment.errorPx).toBeLessThan(4);
    }
  });

  it('is fixed by two pins far apart', () => {
    const exact = { offsetX: 9, offsetY: -6, scaleX: 0.9512, scaleY: 1.0371, flipY: true };
    const fit = fitAlignment(pinsFor(exact, [[0.05, 0.1], [0.95, 0.9]]), WIDTH, HEIGHT, BASE);
    expect('alignment' in fit && fit.alignment).toMatchObject(exact);
  });

  it('explains what is missing or wrong', () => {
    const exact = { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1, flipY: false };
    expect(fitAlignment(pinsFor(exact, SOURCES.slice(0, 1)), WIDTH, HEIGHT, BASE)).toEqual({
      problem: 'Drag 1 more sensor(s) onto their place.',
    });
    // Two pins close together (or in one row) don't fix it.
    const close = fitAlignment(pinsFor(exact, [[0.4, 0.4], [0.5, 0.9]]), WIDTH, HEIGHT, BASE);
    expect('problem' in close && close.problem).toContain('too close together');
    // All in one row: nothing to tell the y scale from.
    const row = fitAlignment(pinsFor(exact, [[0.1, 0.5], [0.5, 0.5], [0.9, 0.5]]), WIDTH, HEIGHT, BASE);
    expect('problem' in row && row.problem).toContain('not all in one row');
    const mirrored = pinsFor({ ...exact, scaleX: -1 }, SOURCES);
    expect('problem' in fitAlignment(mirrored, WIDTH, HEIGHT, BASE)).toBe(true);
  });
});
