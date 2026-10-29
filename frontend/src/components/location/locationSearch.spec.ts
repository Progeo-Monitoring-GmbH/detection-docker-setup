import { describe, expect, it } from 'vitest';
import {
  foldSearchText,
  locationAddressLine,
  locationLabel,
  matchesLocationSearch,
} from './locationSearch';

const location = {
  id: 7,
  project_id: 24017,
  name: 'Müller GmbH',
  address: 'Hauptstraße 5',
  plz: '10115',
  city: 'Berlin',
  country: 'Deutschland',
  manager: 'Erika Muster',
  telefon: null,
  mail: undefined,
};

describe('matchesLocationSearch', () => {
  it('matches an empty query', () => {
    expect(matchesLocationSearch(location, '')).toBe(true);
    expect(matchesLocationSearch(location, '   ')).toBe(true);
  });

  it('finds every field, ignoring case and diacritics', () => {
    for (const query of [
      'muller',
      'HAUPTSTRASSE',
      'hauptstraße',
      '10115',
      'berlin',
      'deutsch',
      'erika',
      '24017',
    ]) {
      expect(matchesLocationSearch(location, query)).toBe(true);
    }
  });

  it('needs every word, in any field and order', () => {
    expect(matchesLocationSearch(location, 'berlin müller')).toBe(true);
    expect(matchesLocationSearch(location, 'berlin hamburg')).toBe(false);
  });

  it('does not match missing fields', () => {
    expect(matchesLocationSearch(location, 'undefined')).toBe(false);
    expect(matchesLocationSearch({ name: 'X' }, 'null')).toBe(false);
  });
});

describe('labels', () => {
  it('folds text', () => {
    expect(foldSearchText('Äpfel Öl')).toBe('apfel ol');
  });

  it('builds the address line from the parts it has', () => {
    expect(locationAddressLine(location)).toBe('Hauptstraße 5, 10115 Berlin');
    expect(locationAddressLine({ city: 'Berlin' })).toBe('Berlin');
    expect(locationAddressLine({})).toBe('');
  });

  it('labels by name and project id, falling back to address and id', () => {
    expect(locationLabel(location)).toBe('Müller GmbH (#24017)');
    expect(locationLabel({ id: 3, address: 'Weg 1' })).toBe('Weg 1 (#3)');
    expect(locationLabel({})).toBe('Location');
  });
});
