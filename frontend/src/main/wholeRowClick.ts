import type { MouseEvent } from 'react';

/**
 * Opens the row a click landed on, wherever in the row it landed.
 *
 * DataTable's own onRowClicked only fires when the clicked element itself is
 * tagged data-tag="allowRowEvents" - in custom cells (the name with its
 * star, the state dot, the flag icons) the click hits an untagged child and
 * nothing happens, so a row seemed to need a double click or "the right
 * spot". This catches exactly those clicks; tagged ones stay with
 * onRowClicked (also Enter on a focused row), buttons and links with
 * themselves.
 */
export const untaggedRowClick =
  <T extends { id: number | string }>(
    rows: T[],
    onRow: (row: T) => void,
    /** The DataTable keyField's value - when it isn't `id`. */
    keyOf: (row: T) => string | number = (row) => row.id,
  ) =>
  (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    if (target.getAttribute('data-tag') === 'allowRowEvents') {
      return;
    }
    if (target.closest('button, a, input, select, textarea, label')) {
      return;
    }
    const rowElement = target.closest('.rdt_TableRow');
    const id = rowElement ? /^row-(.+)$/.exec(rowElement.id)?.[1] : undefined;
    const row = id != null ? rows.find((candidate) => String(keyOf(candidate)) === id) : undefined;
    if (row) {
      onRow(row);
    }
  };
