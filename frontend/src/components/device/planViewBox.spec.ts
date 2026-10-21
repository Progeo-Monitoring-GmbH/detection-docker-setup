import { describe, expect, it } from 'vitest';
import { framePosition } from './FrameSlider';
import { fullBox, isFull, MAX_ZOOM, panBox, zoomBox } from './planViewBox';

const full = fullBox(1600, 1200);

describe('plan view box', () => {
  it('keeps the zoom point in place', () => {
    const box = zoomBox(full, 2, 400, 300, full);
    expect(box).toEqual({ x: 200, y: 150, w: 800, h: 600 });
    // (400, 300) sits at the same relative spot as before: a quarter in.
    expect((400 - box.x) / box.w).toBeCloseTo(400 / 1600);
  });

  it('never zooms out beyond the plan or in beyond MAX_ZOOM', () => {
    expect(isFull(zoomBox(full, 0.2, 800, 600, full), full)).toBe(true);
    expect(zoomBox(full, 1000, 800, 600, full).w).toBeCloseTo(1600 / MAX_ZOOM);
  });

  it('pans with the pointer and stops at the plan edge', () => {
    const box = zoomBox(full, 2, 800, 600, full); // 400..1200 x 300..900
    expect(panBox(box, 100, -50, full)).toEqual({ x: 300, y: 350, w: 800, h: 600 });
    expect(panBox(box, 5000, 5000, full)).toEqual({ x: 0, y: 0, w: 800, h: 600 });
    expect(panBox(box, -5000, -5000, full)).toEqual({ x: 800, y: 600, w: 800, h: 600 });
  });
});

describe('framePosition', () => {
  // Frames at 0, 10, 40 s (a gap after the second).
  const timestamps = [0, 10, 40];

  it('places frames evenly on the slider and moments between them in between', () => {
    expect(framePosition(timestamps, 0)).toBe(0);
    expect(framePosition(timestamps, 10_000)).toBe(0.5);
    expect(framePosition(timestamps, 25_000)).toBe(0.75);
    expect(framePosition(timestamps, 40_000)).toBe(1);
  });

  it('has no place for moments outside the frames', () => {
    expect(framePosition(timestamps, -1000)).toBeNaN();
    expect(framePosition(timestamps, 41_000)).toBeNaN();
  });
});
