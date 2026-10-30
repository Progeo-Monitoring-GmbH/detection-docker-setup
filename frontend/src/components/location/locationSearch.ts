/**
 * Finding locations by text - shared by LocationPicker and the location
 * lists (LocationsOverview, LocationsMapView), so every search matches the
 * same fields the same way.
 */

/** The searchable fields of a location (ProgeoLocationMinSerializer and
 * friends) - all optional, every list carries a different subset. */
export type SearchableLocation = {
  id?: number | null;
  project_id?: number | null;
  name?: string | null;
  address?: string | null;
  plz?: string | null;
  city?: string | null;
  country?: string | null;
  manager?: string | null;
  telefon?: string | null;
  mail?: string | null;
  /** Name of the owning account (Objektverwaltung). */
  owner?: string | null;
};

const SEARCH_FIELDS: Array<keyof SearchableLocation> = [
  'project_id',
  'name',
  'address',
  'plz',
  'city',
  'country',
  'manager',
  'telefon',
  'mail',
  'owner',
];

/** Lower case without diacritics, so "muller" finds "Müller" and
 * "strasse" finds "Straße". */
export const foldSearchText = (value: string) =>
  value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/ß/g, 'ss');

const searchTextCache = new WeakMap<object, string>();

/** All searchable fields of a location as one folded string (cached per
 * object - the lists filter on every keystroke). */
const locationSearchText = (location: SearchableLocation) => {
  let cached = searchTextCache.get(location);
  if (cached === undefined) {
    cached = foldSearchText(
      SEARCH_FIELDS.map((field) => location[field])
        .filter((value) => value !== null && value !== undefined)
        .join(' '),
    );
    searchTextCache.set(location, cached);
  }
  return cached;
};

/** True if every word of `query` appears in one of the location's fields
 * ("müller berlin" finds Müller GmbH in Berlin). An empty query matches. */
export const matchesLocationSearch = (
  location: SearchableLocation,
  query: string,
) => {
  const words = foldSearchText(query).split(/\s+/).filter(Boolean);
  if (!words.length) {
    return true;
  }
  const haystack = locationSearchText(location);
  return words.every((word) => haystack.includes(word));
};

/** "Street 1, 12345 City" - empty if the location has no address. */
export const locationAddressLine = (location: SearchableLocation) =>
  [location.address, [location.plz, location.city].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(', ');

/** "Name (#project id)" - the label of a location in pickers. */
export const locationLabel = (location: SearchableLocation) => {
  const title = location.name || location.address || 'Location';
  const number = location.project_id ?? location.id;
  return number != null ? `${title} (#${number})` : title;
};
