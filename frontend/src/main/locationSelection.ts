import type { TFunction } from 'i18next';

/**
 * Locations selected in the overview (module_locations_selectable) for
 * "Assign to user" and "Merge projects".
 */
export type SelectedLocation = {
  id: number;
  name?: string | null;
  project_id?: number | null;
  /** The parent location (a merged project) - none for a top-level one. */
  parent_location?: number | null;
  /** It is a merged project of this many locations. */
  part_count?: number;
};

/** "#4700 Halle Nord" - the project number first, as in the overview. */
export const locationLabel = (location: SelectedLocation) =>
  [
    location.project_id != null ? `#${location.project_id}` : null,
    location.name,
  ]
    .filter(Boolean)
    .join(' ');

/** The selection in one line: up to three names, then "+ n more". */
export const selectionLabel = (locations: SelectedLocation[], t: TFunction) => {
  const shown = locations.slice(0, 3).map(locationLabel).join(', ');
  const more = locations.length - 3;
  return more > 0 ? `${shown} ${t('selection_more', { count: more })}` : shown;
};

/**
 * Why the selection can't be merged (an i18n key), or null: at least two
 * locations, none of them a merged project already, none merged into one.
 */
export const mergeBlocker = (locations: SelectedLocation[]): string | null => {
  if (locations.length < 2) {
    return 'selection_merge_need_two';
  }
  if (locations.some((location) => (location.part_count ?? 0) > 0)) {
    return 'selection_merge_has_merged';
  }
  if (locations.some((location) => location.parent_location != null)) {
    return 'selection_merge_already_merged';
  }
  return null;
};
