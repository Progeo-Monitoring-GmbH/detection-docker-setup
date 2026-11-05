import { describe, expect, it } from 'vitest';
import { thresholdAreaPath } from './thresholdArea';

describe('thresholdAreaPath', () => {
  it('is one rectangle over all sensors without own thresholds', () => {
    expect(thresholdAreaPath(100, null, 4)).toBe('M1,100L4,100L4,-100L1,-100Z');
  });

  it('raises the area at a sensor with an own threshold - one shape, no gap', () => {
    // Pair index 1 = sensor x 2.
    expect(thresholdAreaPath(100, new Map([[1, 400]]), 4)).toBe(
      'M1,100L1.5,100L1.5,400L2.5,400L2.5,100L4,100' + 'L4,-100L2.5,-100L2.5,-400L1.5,-400L1.5,-100L1,-100Z',
    );
  });

  it('lowers it for an own threshold below the location one', () => {
    expect(thresholdAreaPath(100, new Map([[2, 50]]), 3)).toBe(
      'M1,100L2.5,100L2.5,50L3,50L3,-50L2.5,-50L2.5,-100L1,-100Z',
    );
  });

  it('merges neighbouring sensors with the same own threshold', () => {
    expect(
      thresholdAreaPath(
        null,
        new Map([
          [0, 300],
          [1, 300],
        ]),
        2,
      ),
    ).toBe('M1,300L2,300L2,-300L1,-300Z');
  });

  it('without a location threshold: separate shapes for separate sensors', () => {
    expect(
      thresholdAreaPath(
        0,
        new Map([
          [0, 10],
          [3, 20],
        ]),
        5,
      ),
    ).toBe('M1,10L1.5,10L1.5,-10L1,-10Z M3.5,20L4.5,20L4.5,-20L3.5,-20Z');
  });

  it('is null without any threshold', () => {
    expect(thresholdAreaPath(null, new Map([[0, 0]]), 3)).toBeNull();
  });

  it('gives a single sensor its own width', () => {
    expect(thresholdAreaPath(5, null, 1)).toBe('M0.5,5L1.5,5L1.5,-5L0.5,-5Z');
  });
});
