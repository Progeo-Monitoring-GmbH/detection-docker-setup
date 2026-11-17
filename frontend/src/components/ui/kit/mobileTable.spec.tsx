// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import DataTable, { type TableColumn } from 'react-data-table-component';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useMobileColumns } from './mobileTable';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// The phone switch: useIsMobile asks matchMedia (jsdom has none).
let phone = false;
window.matchMedia = (query: string) =>
  ({
    matches: query.includes('max-width') ? phone : false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }) as MediaQueryList;

type Row = { id: number; name: string; city: string; owner: string };

const rows: Row[] = [
  { id: 1, name: 'Halle Nord', city: 'Köln', owner: 'Kunde A' },
];

const columns: TableColumn<Row>[] = [
  { id: 'name', name: 'Objekt', selector: (row) => row.name },
  { id: 'city', name: 'Ort', selector: (row) => row.city },
  {
    id: 'owner',
    name: 'Kunde',
    cell: (row) => <button type="button">{row.owner}</button>,
  },
];

const Table = ({ keep }: { keep?: string[] }) => {
  const mobile = useMobileColumns(columns, keep);
  return (
    <DataTable
      columns={mobile.columns}
      data={rows}
      keyField="id"
      {...mobile.expandable}
    />
  );
};

describe('useMobileColumns', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    phone = false;
  });

  const headers = () =>
    [...container.querySelectorAll('.rdt_TableCol')]
      .map((cell) => cell.textContent?.trim())
      .filter(Boolean);

  it('keeps every column off phones', () => {
    act(() => root.render(<Table keep={['name']} />));
    expect(headers()).toEqual(['Objekt', 'Ort', 'Kunde']);
    expect(
      container.querySelector('[data-testid^="expander-button-"]'),
    ).toBeNull();
  });

  it('moves the other columns into the row expander on phones', () => {
    phone = true;
    act(() => root.render(<Table keep={['name']} />));
    expect(headers()).toEqual(['Objekt']);
    expect(container.querySelector('.progeo-mobile-table')).not.toBeNull();

    const expander = container.querySelector<HTMLButtonElement>(
      '[data-testid^="expander-button-"]',
    );
    expect(expander).not.toBeNull();
    act(() => expander?.click());

    const details = container.querySelector(
      '[data-testid="mobile-row-details"]',
    );
    expect(
      [...(details?.querySelectorAll('dt') ?? [])].map((dt) => dt.textContent),
    ).toEqual(['Ort', 'Kunde']);
    expect(details?.textContent).toContain('Köln');
    // The cell renders as in the table - its button stays usable.
    expect(details?.querySelector('button')?.textContent).toBe('Kunde A');
  });

  it('leaves the table as it is on phones without kept columns', () => {
    phone = true;
    act(() => root.render(<Table />));
    expect(headers()).toEqual(['Objekt', 'Ort', 'Kunde']);
  });
});
