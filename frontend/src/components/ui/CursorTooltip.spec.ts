import { describe, expect, it } from 'vitest';
import { tooltipPosition } from './CursorTooltip';

const SIZE = { width: 100, height: 40 };
const CONTAINER = { width: 500, height: 300 };

describe('tooltipPosition', () => {
  it('centers above the cursor', () => {
    expect(tooltipPosition([250, 200], SIZE, CONTAINER)).toEqual({ left: 250, top: 110 });
  });

  it('keeps clear of the container edges', () => {
    expect(tooltipPosition([10, 200], SIZE, CONTAINER).left).toBe(58);
    expect(tooltipPosition([495, 200], SIZE, CONTAINER).left).toBe(442);
  });

  it('flips below the cursor without room up top, within the container', () => {
    expect(tooltipPosition([250, 60], SIZE, CONTAINER).top).toBe(110);
    expect(tooltipPosition([250, 60], SIZE, { width: 500, height: 120 }).top).toBe(72);
  });
});
