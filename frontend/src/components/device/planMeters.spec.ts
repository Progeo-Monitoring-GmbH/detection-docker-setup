import { describe, expect, it } from 'vitest';
import {
  formatMeters,
  isCalibrated,
  planPixel,
  pointMeters,
  type PlanScale,
} from './planMeters';

// Same cases as progeo/tests/test_plan_meters.py - both implementations
// must agree.
const plan = (fields: PlanScale = {}): PlanScale => ({
  offset_x: 0,
  offset_y: 0,
  scale_x: 1,
  scale_y: 1,
  flip_y: false,
  reference_x: 100,
  reference_y: 200,
  meters_per_pixel: 0.01,
  ...fields,
});
const size = { width: 1000, height: 500 };

describe('planPixel', () => {
  it('maps normalized coordinates to image pixels', () => {
    expect(planPixel(0.5, 0.1, plan(), size)).toEqual([500, 50]);
  });

  it('mirrors y for a flipped plan', () => {
    expect(planPixel(0.5, 0.1, plan({ flip_y: true }), size)).toEqual([500, 450]);
  });

  it('treats offsets as wizard canvas pixels', () => {
    // 1000x500 fits the wizard canvas at min(868/1000, 568/500) = 0.868.
    const [px, py] = planPixel(0, 0, plan({ offset_x: 35, offset_y: -10 }), size);
    expect(px).toBeCloseTo(35 / 0.868, 6);
    expect(py).toBeCloseTo(-10 / 0.868, 6);
  });

  it('stretches by the scales', () => {
    const [px, py] = planPixel(1, 1, plan({ scale_x: 0.92, scale_y: 0.49 }), size);
    expect(px).toBeCloseTo(920, 6);
    expect(py).toBeCloseTo(245, 6);
  });
});

describe('pointMeters', () => {
  it('counts right and up from the reference point', () => {
    const [x, y] = pointMeters(0.15, 0.46, plan(), size)!;
    expect(x).toBeCloseTo(0.5, 6);
    expect(y).toBeCloseTo(-0.3, 6);
  });

  it.each(['reference_x', 'reference_y', 'meters_per_pixel'] as const)(
    'is null without %s',
    (field) => {
      expect(isCalibrated(plan({ [field]: null }))).toBe(false);
      expect(pointMeters(0.5, 0.5, plan({ [field]: null }), size)).toBeNull();
    },
  );

  it('is null without the image size', () => {
    expect(pointMeters(0.5, 0.5, plan(), null)).toBeNull();
  });
});

describe('formatMeters', () => {
  it('rounds to centimeters and shows absolute distances', () => {
    expect(formatMeters([12.345, -3.2])).toBe('x 12.35 m, y 3.20 m');
    expect(formatMeters([-0.004, 0])).toBe('x 0.00 m, y 0.00 m');
  });
});
