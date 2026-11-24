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
  mergeMainDefault,
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

  it('merges two or more locations - none merged into another one already', () => {
    expect(mergeBlocker([{ id: 1 }])).toBe('selection_merge_need_two');
    expect(mergeBlocker([{ id: 1 }, { id: 2 }])).toBeNull();
    // An older merged project with its parts: it becomes the main project.
    expect(mergeBlocker([{ id: 9, part_count: 2 }, { id: 1, parent_location: 9 }])).toBeNull();
    expect(
      mergeBlocker([{ id: 8, part_count: 2 }, { id: 9, part_count: 3 }]),
    ).toBe('selection_merge_has_merged');
    // A part whose project isn't selected, or one merged (devices moved) already.
    expect(mergeBlocker([{ id: 1, parent_location: 9 }, { id: 2 }])).toBe(
      'selection_merge_already_merged',
    );
    expect(mergeBlocker([{ id: 9 }, { id: 1, parent_location: 9, merged: true }])).toBe(
      'selection_merge_already_merged',
    );
  });

  it('proposes an older merged project, else the first location as the main project', () => {
    expect(mergeMainDefault([{ id: 1 }, { id: 9, part_count: 2 }])).toBe(9);
    expect(mergeMainDefault([{ id: 4 }, { id: 5 }])).toBe(4);
    expect(mergeMainDefault([])).toBe('new');
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
    expect(portalSegment('/project/4711/analysis')).toBe('analysis');
    expect(portalSegment('/project/4711')).toBe('status');
    expect(portalSegment('/location/12/analysis')).toBe('analysis');
    expect(planFromParams(new URLSearchParams('plan=12'))).toBe(12);
    expect(planFromParams(new URLSearchParams('plan=x'))).toBeNull();
    expect(planFromParams(new URLSearchParams(''))).toBeNull();
  });
});
