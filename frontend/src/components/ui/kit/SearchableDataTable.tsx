import { useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import DataTable, { type TableColumn, type TableProps } from 'react-data-table-component';
import { Search, XLg } from 'react-bootstrap-icons';
import { matchesSearchWords, rowSearchText, searchWords } from './tableSearch';

/** A DataTable column plus what the global search should read from it. */
export type SearchableColumn<T> = TableColumn<T> & {
  /** Search text of the column instead of the selector's value - for cells
   * rendering text the selector doesn't return (or no selector at all). */
  searchText?: (row: T) => string | null | undefined;
};

/** Checkbox selection kept by the caller as a set of row keys, so it
 * survives sorting, filtering and reloaded row objects. */
export type RowSelection<T, K> = {
  rowKey: (row: T) => K;
  selected: ReadonlySet<K>;
  onChange: (next: Set<K>) => void;
  /** Clicking a row toggles it (default). Custom cells must tag their inner
   * elements with ROW_CLICK - DataTable only reacts to clicks on tagged ones. */
  toggleOnRowClick?: boolean;
};

export type SearchableDataTableLabels = {
  placeholder: string;
  clear: string;
  count: (shown: number, total: number) => string;
  noMatches: ReactNode;
  selectAll: string;
  selectRow: string;
};

const DEFAULT_LABELS: SearchableDataTableLabels = {
  placeholder: 'Search all columns…',
  clear: 'Clear search',
  count: (shown, total) => `${shown} of ${total}`,
  noMatches: 'No rows match the search.',
  selectAll: 'Select all shown rows',
  selectRow: 'Select row',
};

/**
 * Spread onto the elements inside a custom cell, so clicking them still
 * counts as a row click (DataTable ignores clicks on untagged elements).
 */
export const ROW_CLICK = { 'data-tag': 'allowRowEvents' } as const;

/** The progeo look of DataTable (as SensorListTable): transparent rows on the
 * panel surface, small uppercase grey headers. */
export const progeoTableStyles = {
  table: { style: { backgroundColor: 'transparent' } },
  headRow: {
    style: {
      minHeight: '36px',
      backgroundColor: 'transparent',
      borderBottomColor: 'var(--progeo-track-soft)',
    },
  },
  headCells: {
    style: {
      fontSize: '10.5px',
      letterSpacing: '.06em',
      textTransform: 'uppercase' as const,
      color: '#8B8383',
      fontWeight: 500,
    },
  },
  rows: {
    style: {
      minHeight: '36px',
      fontSize: '12.5px',
      backgroundColor: 'transparent',
      '&:not(:last-of-type)': { borderBottomColor: 'var(--progeo-track-soft)' },
    },
  },
};

const toggled = <K,>(selected: ReadonlySet<K>, key: K) => {
  const next = new Set(selected);
  if (next.has(key)) {
    next.delete(key);
  } else {
    next.add(key);
  }
  return next;
};

const SELECTED_ROW_STYLE = { backgroundColor: 'var(--progeo-track-soft)' };

type CheckboxProps = {
  checked: boolean;
  indeterminate?: boolean;
  disabled?: boolean;
  onChange: () => void;
  label: string;
};

const Checkbox = ({ checked, indeterminate = false, disabled, onChange, label }: CheckboxProps) => (
  <input
    type="checkbox"
    className="form-check-input m-0"
    aria-label={label}
    checked={checked}
    disabled={disabled}
    onChange={onChange}
    // `indeterminate` exists only as a DOM property, not as an attribute.
    ref={(element) => {
      if (element) {
        element.indeterminate = indeterminate;
      }
    }}
    style={{ cursor: disabled ? 'default' : 'pointer' }}
  />
);

export type SearchableDataTableProps<T, K> = Omit<TableProps<T>, 'columns' | 'data'> & {
  /** Keep stable (module constant or useMemo): the rows' search texts are
   * rebuilt whenever `columns`, `data` or `rowSearchText` change. */
  columns: SearchableColumn<T>[];
  data: T[];
  /** Extra search text per row - fields no column shows, or shows as icons. */
  rowSearchText?: (row: T) => string | null | undefined;
  /** Checkbox column managed by the caller (instead of DataTable's own
   * `selectableRows`, which forgets hidden rows when the filter changes). */
  selection?: RowSelection<T, K>;
  labels?: Partial<SearchableDataTableLabels>;
  /** Content right of the search field (filters, actions). */
  toolbar?: ReactNode;
};

/**
 * DataTable with one search field above it that filters across all columns:
 * every word of the query must occur in some column (case and diacritics
 * ignored, see tableSearch.ts). Every other DataTable prop passes through.
 *
 * With `selection`, "select all" toggles the rows the filter shows; selected
 * rows the filter hides stay selected.
 */
const SearchableDataTable = <T, K = string | number>({
  columns,
  data,
  rowSearchText: extraSearchText,
  selection,
  labels: labelOverrides,
  toolbar,
  customStyles = progeoTableStyles,
  noDataComponent,
  onRowClicked,
  pointerOnHover,
  conditionalRowStyles,
  ...tableProps
}: SearchableDataTableProps<T, K>) => {
  const [query, setQuery] = useState('');
  const labels = { ...DEFAULT_LABELS, ...labelOverrides };

  // Built once per data/columns, not per keystroke.
  const searchTexts = useMemo(
    () => data.map((row, index) => rowSearchText(row, index, columns, extraSearchText)),
    [data, columns, extraSearchText],
  );

  const words = useMemo(() => searchWords(query), [query]);
  const rows = useMemo(
    () => (words.length ? data.filter((_row, index) => matchesSearchWords(searchTexts[index], words)) : data),
    [data, searchTexts, words],
  );

  const rowClickToggles = !!selection && selection.toggleOnRowClick !== false;

  const tableColumns = useMemo<TableColumn<T>[]>(() => {
    // DataTable doesn't know `searchText` - keep it out of its columns.
    const plain = columns.map(({ searchText: _searchText, ...column }) => column);
    if (!selection) {
      return plain;
    }
    const { rowKey, selected, onChange } = selection;
    const shownSelected = rows.filter((row) => selected.has(rowKey(row))).length;
    const allShownSelected = rows.length > 0 && shownSelected === rows.length;

    const toggleShown = () => {
      const next = new Set(selected);
      for (const row of rows) {
        if (allShownSelected) {
          next.delete(rowKey(row));
        } else {
          next.add(rowKey(row));
        }
      }
      onChange(next);
    };

    return [
      {
        id: '__selected',
        name: (
          <Checkbox
            label={labels.selectAll}
            checked={allShownSelected}
            indeterminate={shownSelected > 0 && !allShownSelected}
            disabled={!rows.length}
            onChange={toggleShown}
          />
        ),
        cell: (row) => (
          <Checkbox
            label={labels.selectRow}
            checked={selected.has(rowKey(row))}
            onChange={() => onChange(toggled(selected, rowKey(row)))}
          />
        ),
        width: '48px',
        // The checkbox toggles itself; a row click on top would undo it.
        ignoreRowClick: true,
      },
      ...plain,
    ];
  }, [columns, selection, rows, labels.selectAll, labels.selectRow]);

  const rowStyles = useMemo(() => {
    if (!selection) {
      return conditionalRowStyles;
    }
    const { rowKey, selected } = selection;
    return [
      { when: (row: T) => selected.has(rowKey(row)), style: SELECTED_ROW_STYLE },
      ...(conditionalRowStyles ?? []),
    ];
  }, [selection, conditionalRowStyles]);

  const handleRowClicked = (row: T, event: MouseEvent) => {
    if (selection && rowClickToggles) {
      selection.onChange(toggled(selection.selected, selection.rowKey(row)));
    }
    onRowClicked?.(row, event);
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
        <div style={{ position: 'relative', flex: '1 1 220px', maxWidth: 360 }}>
          <Search
            aria-hidden
            size={13}
            style={{
              position: 'absolute',
              left: 13,
              top: '50%',
              transform: 'translateY(-50%)',
              color: '#8B8383',
              pointerEvents: 'none',
            }}
          />
          <input
            type="search"
            value={query}
            placeholder={labels.placeholder}
            aria-label={labels.placeholder}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setQuery('');
              }
            }}
            style={{
              width: '100%',
              height: 34,
              border: 'none',
              borderRadius: 'var(--progeo-radius-pill)',
              background: 'var(--progeo-surface)',
              boxShadow: '0 1px 4px rgba(11, 54, 89, .09)',
              padding: '0 34px 0 34px',
              fontFamily: 'inherit',
              fontSize: 13,
              color: 'var(--progeo-blue)',
              // The browser's own clear button would duplicate ours.
              appearance: 'none',
              WebkitAppearance: 'none',
            }}
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label={labels.clear}
              title={labels.clear}
              style={{
                position: 'absolute',
                right: 6,
                top: '50%',
                transform: 'translateY(-50%)',
                width: 24,
                height: 24,
                border: 'none',
                borderRadius: '50%',
                background: 'var(--progeo-track-soft)',
                color: '#6E6868',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 0,
                cursor: 'pointer',
              }}
            >
              <XLg size={10} />
            </button>
          )}
        </div>
        {words.length > 0 && (
          <span style={{ fontSize: 12, color: '#8B8383', whiteSpace: 'nowrap' }} aria-live="polite">
            {labels.count(rows.length, data.length)}
          </span>
        )}
        {toolbar && <div style={{ marginLeft: 'auto' }}>{toolbar}</div>}
      </div>
      <DataTable
        {...tableProps}
        columns={tableColumns}
        data={rows}
        customStyles={customStyles}
        conditionalRowStyles={rowStyles}
        onRowClicked={handleRowClicked}
        pointerOnHover={pointerOnHover ?? rowClickToggles}
        noDataComponent={
          words.length && data.length ? (
            <div style={{ color: '#8B8383', fontSize: 13, padding: '14px 2px' }}>{labels.noMatches}</div>
          ) : (
            noDataComponent
          )
        }
      />
    </div>
  );
};

export default SearchableDataTable;
