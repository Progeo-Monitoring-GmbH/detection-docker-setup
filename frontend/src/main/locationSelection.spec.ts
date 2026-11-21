import type { TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';
import {
  groupPills,
  portalSegment,
  type LocationGroup,
} from './LocationGroupBar';
import {
  selectedLocationLabel,
  mergeBlocker,
  selectionLabel,
} from './locationSelection';
import { planFromParams } from './planParam';

const t = ((key: string, options?: Record<string, unknown>) =>
  options ? `${key} ${JSON.stringify(options)}` : key) as unknown as TFunction;

describe('the overview selection', () => {
  it('labels the locations with their project number', () => {
    expect(selectedLocationLabel({ id: 1, project_id: 4700, name: 'Halle Nord' })).toBe(
      '#4700 Halle Nord',
    );
    expect(selectedLocationLabel({ id: 2, name: 'Ohne Nummer' })).toBe('Ohne Nummer');
    const many = [1, 2, 3, 4, 5].map((id) => ({ id, project_id: 4700 + id }));
    expect(selectionLabel(many, t)).toBe(
      '#4701, #4702, #4703 selection_more {"count":2}',
    );
  });

  it('merges two or more locations - none merged already, none a merged project', () => {
    expect(mergeBlocker([{ id: 1 }])).toBe('selection_merge_need_two');
    expect(mergeBlocker([{ id: 1 }, { id: 2 }])).toBeNull();
    expect(mergeBlocker([{ id: 1 }, { id: 2, part_count: 3 }])).toBe(
      'selection_merge_has_merged',
    );
    expect(mergeBlocker([{ id: 1, parent_location: 9 }, { id: 2 }])).toBe(
      'selection_merge_already_merged',
    );
  });
});

describe('the merged project bar', () => {
  const group: LocationGroup = {
    parent: { id: 9, name: 'Werk', project_id: 4800 },
    parts: [
      {
        id: 1,
        name: 'Halle Nord',
        project_id: 4700,
        lageplans: [
          { id: 11, name: 'EG' },
          { id: 12, name: 'OG' },
        ],
      },
      { id: 2, name: 'Halle Süd', project_id: 4701, lageplans: [] },
    ],
  };

  it('has a pill per plan of every part - a part without plans gets one', () => {
    expect(
      groupPills(group).map(
        ({ part, plan }) => `${part.id}:${plan?.id ?? '-'}`,
      ),
    ).toEqual(['1:11', '1:12', '2:-']);
  });

  it('knows the tab and the plan of the URL', () => {
    expect(portalSegment('/location/12/analysis')).toBe('analysis');
    expect(portalSegment('/location/12')).toBe('status');
    expect(planFromParams(new URLSearchParams('plan=12'))).toBe(12);
    expect(planFromParams(new URLSearchParams('plan=x'))).toBeNull();
    expect(planFromParams(new URLSearchParams(''))).toBeNull();
  });
});
