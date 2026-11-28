import { describe, expect, it } from 'vitest';
import { SWIPE_MIN_PX, tabSwipeTarget } from './deviceKindTabsLogic';

const BOTH = ['leak', 'climate'] as const;

describe('tabSwipeTarget', () => {
  it('swiping left goes to the next tab, right to the previous one', () => {
    expect(tabSwipeTarget(BOTH, 'leak', -80, 10)).toBe('climate');
    expect(tabSwipeTarget(BOTH, 'climate', 80, 10)).toBe('leak');
  });

  it('does nothing at the edge', () => {
    expect(tabSwipeTarget(BOTH, 'leak', 80, 10)).toBeNull();
    expect(tabSwipeTarget(BOTH, 'climate', -80, 10)).toBeNull();
  });

  it('needs a long enough, clearly horizontal gesture', () => {
    expect(SWIPE_MIN_PX).toBe(60);
    expect(tabSwipeTarget(BOTH, 'leak', -59, 0)).toBeNull();
    expect(tabSwipeTarget(BOTH, 'leak', -60, 0)).toBe('climate');
    // Vertical scrolling of the page stays a scroll.
    expect(tabSwipeTarget(BOTH, 'leak', -80, 50)).toBeNull();
    expect(tabSwipeTarget(BOTH, 'leak', -80, 40)).toBeNull();
  });

  it('a single tab never swipes', () => {
    expect(tabSwipeTarget(['leak'], 'leak', -200, 0)).toBeNull();
  });
});
