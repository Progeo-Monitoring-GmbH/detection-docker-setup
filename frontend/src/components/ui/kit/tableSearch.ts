/**
 * The global text filter of SearchableDataTable: one query over every
 * column of a table. Pure, so the matching rules are testable without
 * rendering a table.
 */
import { foldSearchText } from '../../location/locationSearch';

/** The part of a DataTable column (TableColumn<T>) the search reads. */
export type SearchColumn<T> = {
  selector?: (row: T, rowIndex?: number) => unknown;
  /** Replaces the selector's value as the column's search text - for cells
   * that render more (or other) text than the selector returns. */
  searchText?: (row: T) => string | null | undefined;
  /** Hidden columns don't match - the user can't see why a row is shown. */
  omit?: boolean;
};

/** What the selector returns as searchable text: strings and numbers only.
 * React nodes, booleans and dates have no text the user sees verbatim -
 * such columns need a `searchText`. */
const selectorText = (value: unknown) =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint' ? String(value) : '';

/**
 * Every column's text of one row as one folded string. The columns are
 * joined by newlines, which no query word contains, so a word never matches
 * across two columns.
 */
export const rowSearchText = <T>(
  row: T,
  rowIndex: number,
  columns: SearchColumn<T>[],
  extraText?: (row: T) => string | null | undefined,
) => {
  const parts: string[] = [];
  for (const column of columns) {
    if (column.omit) {
      continue;
    }
    const text = column.searchText ? column.searchText(row) : selectorText(column.selector?.(row, rowIndex));
    if (text) {
      parts.push(text);
    }
  }
  const extra = extraText?.(row);
  if (extra) {
    parts.push(extra);
  }
  return foldSearchText(parts.join('\n'));
};

/** The query's words, folded like the row text; empty for a blank query. */
export const searchWords = (query: string) => foldSearchText(query).split(/\s+/).filter(Boolean);

/** Every word must occur somewhere in the row - each may hit another column. */
export const matchesSearchWords = (text: string, words: string[]) => words.every((word) => text.includes(word));

/** The rows matching `query` (all rows for a blank query), in their order. */
export const filterRowsBySearch = <T>(
  rows: T[],
  columns: SearchColumn<T>[],
  query: string,
  extraText?: (row: T) => string | null | undefined,
) => {
  const words = searchWords(query);
  if (!words.length) {
    return rows;
  }
  return rows.filter((row, index) => matchesSearchWords(rowSearchText(row, index, columns, extraText), words));
};
