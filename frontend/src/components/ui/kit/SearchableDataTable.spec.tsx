// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import SearchableDataTable, { ROW_CLICK, type SearchableColumn } from './SearchableDataTable';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// DataTable follows the colour scheme; jsdom has no matchMedia.
window.matchMedia ??= (query: string) =>
  ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }) as MediaQueryList;

type Row = { id: number; name: string; sheets: string[] };

const data: Row[] = [
  { id: 3, name: 'Kita Leingarten', sheets: ['smartex dm'] },
  { id: 1, name: 'Müller GmbH', sheets: [] },
  { id: 2, name: 'Kita Nord', sheets: ['Leckortung'] },
];

const columns: SearchableColumn<Row>[] = [
  { id: 'id', name: 'ID', selector: (row) => row.id, sortable: true },
  { id: 'name', name: 'Name', selector: (row) => row.name, sortable: true },
  {
    id: 'sheets',
    name: 'Sheets',
    searchText: (row) => row.sheets.join(' '),
    cell: (row) => <span {...ROW_CLICK}>{row.sheets.join(', ')}</span>,
  },
];

/** The selection after the last change (set from the handler, not during render). */
let selectedNow = new Set<number>();

const Harness = ({ initial = [] }: { initial?: number[] }) => {
  const [selected, setSelected] = useState(() => new Set(initial));
  const onChange = (next: Set<number>) => {
    selectedNow = next;
    setSelected(next);
  };
  return (
    <SearchableDataTable
      columns={columns}
      data={data}
      keyField="id"
      defaultSortFieldId="id"
      selection={{ rowKey: (row) => row.id, selected, onChange }}
    />
  );
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  selectedNow = new Set();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const search = (value: string) => {
  const input = container.querySelector<HTMLInputElement>('input[type="search"]')!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setValue.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const shownIds = () =>
  Array.from(container.querySelectorAll('[role="row"]'))
    .slice(1)
    .map((row) => row.querySelector('[data-column-id="id"]')?.textContent);

const click = (element: Element | null) => act(() => (element as HTMLElement).click());

describe('SearchableDataTable', () => {
  it('filters across columns and shows the count', () => {
    act(() => root.render(<Harness />));
    expect(shownIds()).toEqual(['1', '2', '3']);

    search('kita leck');
    expect(shownIds()).toEqual(['2']);
    expect(container.textContent).toContain('1 of 3');

    click(container.querySelector('button[aria-label="Clear search"]'));
    expect(shownIds()).toEqual(['1', '2', '3']);
    expect(container.textContent).not.toContain('of 3');
  });

  it('says so when nothing matches', () => {
    act(() => root.render(<Harness />));
    search('nothing');
    expect(container.textContent).toContain('No rows match the search.');
  });

  it('select all toggles the shown rows and keeps hidden ones', () => {
    act(() => root.render(<Harness initial={[1]} />));
    search('kita');
    const selectAll = () => container.querySelector('input[aria-label="Select all shown rows"]');

    click(selectAll());
    expect([...selectedNow].sort()).toEqual([1, 2, 3]);

    click(selectAll());
    expect([...selectedNow]).toEqual([1]);
  });

  it('toggles a row by its checkbox and by a click on the row', () => {
    act(() => root.render(<Harness />));
    const rowOf = (id: string) =>
      Array.from(container.querySelectorAll('[role="row"]')).find(
        (row) => row.querySelector('[data-column-id="id"]')?.textContent === id,
      )!;

    click(rowOf('2').querySelector('input[type="checkbox"]'));
    expect([...selectedNow]).toEqual([2]);

    click(rowOf('3').querySelector('span[data-tag="allowRowEvents"]'));
    expect([...selectedNow].sort()).toEqual([2, 3]);

    click(rowOf('2').querySelector('[data-column-id="name"]'));
    expect([...selectedNow]).toEqual([3]);
  });

  it('keeps the selection when sorting', () => {
    act(() => root.render(<Harness initial={[3]} />));
    // The table starts sorted by ID - another click sorts descending.
    click(container.querySelector('[data-column-id="id"] .rdt_TableCol_Sortable'));
    expect(shownIds()).toEqual(['3', '2', '1']);
    // Sorting never reports a selection change.
    expect(selectedNow.size).toBe(0);
    const checked = Array.from(
      container.querySelectorAll<HTMLInputElement>('[role="row"] input[aria-label="Select row"]'),
    ).map((input) => input.checked);
    expect(checked).toEqual([true, false, false]);
  });
});
