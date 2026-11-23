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
  /** It is an older merged project (nothing moved) of this many locations. */
  part_count?: number;
  /** Merged into its parent_location - devices moved (staff see it). */
  merged?: boolean;
};

/** "#4700 Halle Nord" - the project number first, as in the overview. */
export const selectedLocationLabel = (location: SelectedLocation) =>
  [
    location.project_id != null ? `#${location.project_id}` : null,
    location.name,
  ]
    .filter(Boolean)
    .join(' ');

/** The selection in one line: up to three names, then "+ n more". */
export const selectionLabel = (locations: SelectedLocation[], t: TFunction) => {
  const shown = locations.slice(0, 3).map(selectedLocationLabel).join(', ');
  const more = locations.length - 3;
  return more > 0 ? `${shown} ${t('selection_more', { count: more })}` : shown;
};

/**
 * Why the selection can't be merged (an i18n key), or null: at least two
 * locations, none merged into another one already. An older merged project
 * (part_count, nothing moved) may be selected - with its parts, it is the
 * main project - but not two of them.
 */
export const mergeBlocker = (locations: SelectedLocation[]): string | null => {
  if (locations.length < 2) {
    return 'selection_merge_need_two';
  }
  if (locations.filter((location) => (location.part_count ?? 0) > 0).length > 1) {
    return 'selection_merge_has_merged';
  }
  const ids = new Set(locations.map((location) => location.id));
  if (
    locations.some(
      (location) =>
        location.merged ||
        (location.parent_location != null && !ids.has(location.parent_location)),
    )
  ) {
    return 'selection_merge_already_merged';
  }
  return null;
};

/** The main project the merge dialog proposes: an older merged project of the selection, else the first. */
export const mergeMainDefault = (locations: SelectedLocation[]): number | 'new' =>
  locations.find((location) => (location.part_count ?? 0) > 0)?.id ?? locations[0]?.id ?? 'new';
