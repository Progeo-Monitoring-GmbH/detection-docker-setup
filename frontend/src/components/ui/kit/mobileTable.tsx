import type { ReactNode } from 'react';
import type { ExpanderComponentProps, TableColumn } from 'react-data-table-component';
import useIsMobile from '../useIsMobile';
import './mobileTable.css';

/** A column's content for `row` - its cell, else its format, else its selector. */
const columnContent = <T,>(column: TableColumn<T>, row: T, index: number): ReactNode => {
  if (column.cell) {
    return column.cell(row, index, column, column.id ?? index);
  }
  if (column.format) {
    return column.format(row, index);
  }
  const value = column.selector?.(row, index);
  return value === undefined || value === null || value === '' ? '–' : String(value);
};

/**
 * The columns a phone doesn't show, under the row (DataTable's expandable
 * row): label and content of each, the cells rendered as in the table - so
 * buttons and toggles stay usable.
 */
const MobileRowDetails = <T,>({ row, columns }: { row: T; columns: TableColumn<T>[] }) => (
  <dl className="mobile-row-details" data-testid="mobile-row-details">
    {columns.map((column, index) => (
      <div key={String(column.id ?? index)} className="mobile-row-detail">
        <dt>{column.name}</dt>
        <dd>{columnContent(column, row, index)}</dd>
      </div>
    ))}
  </dl>
);

/**
 * A DataTable on phones: only the `keep` columns (by id) stay in the row, the
 * others move into an expander under it (MobileRowDetails) - nothing is lost,
 * nothing scrolls sideways. Off phones the columns as they are.
 *
 *   const { columns, expandable } = useMobileColumns(allColumns, ['object', 'status']);
 *   <DataTable columns={columns} {...expandable} ... />
 */
export const useMobileColumns = <T,>(
  columns: TableColumn<T>[],
  keep?: string[],
  /** The phone layout on any screen - the table sits in a narrow panel. */
  compact = false,
) => {
  const phone = useIsMobile();
  const mobile = phone || compact;
  // Without `keep` the table stays as it is (and scrolls sideways in its panel).
  if (!mobile || !keep) {
    return { mobile, columns, expandable: {} };
  }
  const isKept = (column: TableColumn<T>) => keep.includes(String(column.id));
  const hidden = columns.filter((column) => !column.omit && !isKept(column));
  const expandable = hidden.length
    ? {
        // Fits the panel instead of the widest content (mobileTable.css).
        className: 'progeo-mobile-table',
        expandableRows: true,
        expandableRowsComponent: ({ data }: ExpanderComponentProps<T>) => (
          <MobileRowDetails row={data} columns={hidden} />
        ),
      }
    : {};
  return {
    mobile,
    columns: columns.map((column) => (isKept(column) ? column : { ...column, omit: true })),
    expandable,
  };
};
