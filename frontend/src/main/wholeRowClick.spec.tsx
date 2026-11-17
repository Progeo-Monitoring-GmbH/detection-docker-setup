// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import DataTable from 'react-data-table-component';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { untaggedRowClick } from './wholeRowClick';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type Row = { id: number; name: string };

const ROWS: Row[] = [
  { id: 4, name: 'Alpha' },
  { id: 9, name: 'Beta' },
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // DataTable asks for the colour scheme; jsdom has no matchMedia.
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** A table with a custom cell (untagged children and a button) and a plain cell. */
const renderTable = (onRow: (row: Row) => void) => {
  act(() => {
    root.render(
      <div onClick={untaggedRowClick(ROWS, onRow)}>
        <DataTable
          data={ROWS}
          onRowClicked={onRow}
          columns={[
            {
              name: 'Name',
              cell: (row) => (
                <span>
                  <strong data-testid={`name-${row.id}`}>{row.name}</strong>
                  <button
                    type="button"
                    data-testid={`star-${row.id}`}
                    onClick={(event) => event.stopPropagation()}
                  >
                    star
                  </button>
                </span>
              ),
            },
            { name: 'Id', selector: (row) => row.id },
          ]}
        />
      </div>,
    );
  });
};

const click = (element: Element | null) => {
  expect(element).not.toBeNull();
  act(() => {
    element!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};

describe('untaggedRowClick', () => {
  it('opens the row from an untagged element inside a custom cell', () => {
    const onRow = vi.fn();
    renderTable(onRow);
    click(container.querySelector('[data-testid="name-9"]'));
    expect(onRow).toHaveBeenCalledTimes(1);
    expect(onRow.mock.calls[0][0]).toEqual(ROWS[1]);
  });

  it('opens a row from a tagged cell once (DataTable itself, not twice)', () => {
    const onRow = vi.fn();
    renderTable(onRow);
    click(container.querySelector('#row-4 [data-tag="allowRowEvents"]'));
    expect(onRow).toHaveBeenCalledTimes(1);
    expect(onRow.mock.calls[0][0]).toEqual(ROWS[0]);
  });

  it('leaves buttons in the row alone', () => {
    const onRow = vi.fn();
    renderTable(onRow);
    click(container.querySelector('[data-testid="star-9"]'));
    expect(onRow).not.toHaveBeenCalled();
  });

  it('finds the row by another keyField (Verwaltung: account + id)', () => {
    type KeyedRow = Row & { key: string };
    const rows: KeyedRow[] = ROWS.map((row) => ({
      ...row,
      key: `7-${row.id}`,
    }));
    const onRow = vi.fn();
    act(() => {
      root.render(
        <div onClick={untaggedRowClick(rows, onRow, (row) => row.key)}>
          <DataTable
            data={rows}
            keyField="key"
            columns={[
              {
                name: 'Name',
                cell: (row) => (
                  <strong data-testid={`keyed-${row.id}`}>{row.name}</strong>
                ),
              },
            ]}
          />
        </div>,
      );
    });
    click(container.querySelector('[data-testid="keyed-9"]'));
    expect(onRow).toHaveBeenCalledTimes(1);
    expect(onRow.mock.calls[0][0]).toEqual(rows[1]);
  });
});
