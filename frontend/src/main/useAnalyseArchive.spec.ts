import { describe, expect, it } from 'vitest';
import { archiveParamsOf } from './useAnalyseArchive';
import { shownPlanId } from './useAnalysePlans';

describe('archiveParamsOf', () => {
  const range = {
    from: Date.parse('2026-11-01T00:00:00Z'),
    to: Date.parse('2026-11-02T00:00:00Z'),
  };

  it('is the span of the shown device', () => {
    expect(archiveParamsOf(range, false, 7)).toEqual({
      from: '2026-11-01T00:00:00.000Z',
      to: '2026-11-02T00:00:00.000Z',
      device: '7',
    });
  });

  it('of every device when asked or none is shown', () => {
    expect(archiveParamsOf(range, true, 7)).not.toHaveProperty('device');
    expect(archiveParamsOf(range, false, null)).not.toHaveProperty('device');
  });

  it('is null without a span', () => {
    expect(archiveParamsOf(null, false, 7)).toBeNull();
  });
});

describe('shownPlanId', () => {
  const plans = [{ id: 1 }, { id: 2 }, { id: 3 }];

  it('is the picked plan of this location, else ?plan=, else the first', () => {
    expect(shownPlanId(plans, { locationId: 5, id: 3 }, 5, 2)).toBe(3);
    expect(shownPlanId(plans, { locationId: 6, id: 3 }, 5, 2)).toBe(2);
    expect(shownPlanId(plans, { locationId: 5, id: 9 }, 5, null)).toBe(1);
    expect(shownPlanId(plans, null, 5, 9)).toBe(1);
    expect(shownPlanId([], null, 5, 2)).toBeNull();
  });
});
