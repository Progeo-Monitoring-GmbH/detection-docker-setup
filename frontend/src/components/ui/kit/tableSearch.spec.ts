import { describe, expect, it } from 'vitest';
import { filterRowsBySearch, rowSearchText, searchWords, type SearchColumn } from './tableSearch';

type Row = { id: number; name: string | null; type: string; sheets: string[]; flag: boolean };

const rows: Row[] = [
  { id: 24017, name: 'Kita Leingarten', type: 'Flachdach', sheets: ['smartex dm'], flag: true },
  { id: 5927, name: 'Müller GmbH', type: 'Tiefgarage', sheets: [], flag: false },
  { id: 31000, name: null, type: 'Flachdach', sheets: ['smartex wl', 'Leckortung'], flag: false },
];

const columns: SearchColumn<Row>[] = [
  { selector: (row) => row.id },
  { selector: (row) => row.name ?? '' },
  { selector: (row) => row.type, searchText: (row) => [row.type, ...row.sheets].join(' ') },
  { selector: (row) => row.flag },
];

const ids = (found: Row[]) => found.map((row) => row.id);

describe('filterRowsBySearch', () => {
  it('keeps every row for a blank query', () => {
    expect(filterRowsBySearch(rows, columns, '')).toBe(rows);
    expect(filterRowsBySearch(rows, columns, '   ')).toBe(rows);
  });

  it('matches any column, ignoring case and diacritics', () => {
    expect(ids(filterRowsBySearch(rows, columns, 'LEINGARTEN'))).toEqual([24017]);
    expect(ids(filterRowsBySearch(rows, columns, 'muller'))).toEqual([5927]);
    expect(ids(filterRowsBySearch(rows, columns, 'flachdach'))).toEqual([24017, 31000]);
  });

  it('stringifies numbers', () => {
    expect(ids(filterRowsBySearch(rows, columns, '592'))).toEqual([5927]);
  });

  it('uses searchText instead of the selector', () => {
    expect(ids(filterRowsBySearch(rows, columns, 'leckortung'))).toEqual([31000]);
  });

  it('needs every word, each may hit another column', () => {
    expect(ids(filterRowsBySearch(rows, columns, 'flachdach kita'))).toEqual([24017]);
    expect(ids(filterRowsBySearch(rows, columns, 'flachdach  wl'))).toEqual([31000]);
    expect(filterRowsBySearch(rows, columns, 'flachdach müller')).toEqual([]);
  });

  it('never matches a word across two columns', () => {
    // "24017" + "Kita" would read "24017kita" if the columns were glued together.
    expect(filterRowsBySearch(rows, columns, '7kita')).toEqual([]);
  });

  it('skips booleans, null and omitted columns', () => {
    expect(filterRowsBySearch(rows, columns, 'true')).toEqual([]);
    expect(filterRowsBySearch(rows, columns, 'null')).toEqual([]);
    const hidden: SearchColumn<Row>[] = [{ selector: (row) => row.id }, { selector: (row) => row.type, omit: true }];
    expect(filterRowsBySearch(rows, hidden, 'tiefgarage')).toEqual([]);
  });

  it('adds the extra row text', () => {
    const extra = (row: Row) => (row.flag ? 'signed' : null);
    expect(ids(filterRowsBySearch(rows, columns, 'signed', extra))).toEqual([24017]);
  });
});

describe('rowSearchText', () => {
  it('passes the row index to the selector', () => {
    expect(rowSearchText(rows[0], 4, [{ selector: (_row, index) => `#${index}` }])).toBe('#4');
  });
});

describe('searchWords', () => {
  it('splits on any whitespace and folds', () => {
    expect(searchWords('  Straße\tKITA \n')).toEqual(['strasse', 'kita']);
  });
});
