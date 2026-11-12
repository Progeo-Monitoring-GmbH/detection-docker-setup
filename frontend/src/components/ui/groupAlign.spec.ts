import { describe, expect, it } from 'vitest';
import { applyGroup, fitGroup, toFraction, toNormalized } from './groupAlign';

const transformOf = (fit: ReturnType<typeof fitGroup>) => {
  if (!('transform' in fit)) {
    throw new Error(fit.problem);
  }
  return fit.transform;
};

describe('fitGroup', () => {
  it('asks for a pin first', () => {
    expect(fitGroup([])).toEqual({ problem: 'Drag one of the selected points onto its place.' });
  });

  it('moves the group with one pin', () => {
    const transform = transformOf(fitGroup([{ source: [0.2, 0.3], target: [0.5, 0.1] }]));
    expect(applyGroup([0.25, 0.35], transform)[0]).toBeCloseTo(0.55);
    expect(applyGroup([0.25, 0.35], transform)[1]).toBeCloseTo(0.15);
  });

  it('moves and scales it with two pins', () => {
    const transform = transformOf(
      fitGroup([
        { source: [0.1, 0.1], target: [0.5, 0.5] },
        { source: [0.2, 0.3], target: [0.7, 0.6] },
      ]),
    );
    expect(transform.x.slope).toBeCloseTo(2);
    expect(transform.y.slope).toBeCloseTo(0.5);
    expect(applyGroup([0.15, 0.2], transform)[0]).toBeCloseTo(0.6);
    expect(applyGroup([0.15, 0.2], transform)[1]).toBeCloseTo(0.55);
  });

  it('takes the scale of the other axis for pins in a row', () => {
    const transform = transformOf(
      fitGroup([
        { source: [0.1, 0.4], target: [0.2, 0.5] },
        { source: [0.3, 0.4], target: [0.6, 0.5] },
      ]),
    );
    expect(transform.y.slope).toBeCloseTo(2);
    expect(transform.y.intercept).toBeCloseTo(0.5 - 2 * 0.4);
  });

  it('refuses a mirroring fit', () => {
    const fit = fitGroup([
      { source: [0.1, 0.1], target: [0.6, 0.1] },
      { source: [0.3, 0.3], target: [0.4, 0.3] },
    ]);
    expect(fit).toEqual({ problem: 'These pins would mirror the points - check that each went to its own place.' });
  });
});

describe('toNormalized', () => {
  it('inverts toFraction for any alignment', () => {
    for (const flipY of [true, false]) {
      const alignment = { offsetX: 37, offsetY: -12, scaleX: 0.8, scaleY: 1.3, flipY };
      const fraction = toFraction([0.42, 0.17], alignment, 1000, 500, 0.868);
      const [nx, ny] = toNormalized(fraction, alignment, 1000, 500, 0.868);
      expect(nx).toBeCloseTo(0.42);
      expect(ny).toBeCloseTo(0.17);
    }
  });
});
