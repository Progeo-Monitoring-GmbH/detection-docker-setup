import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import SearchableDataTable, { ROW_CLICK, type SearchableColumn } from './SearchableDataTable';

type Project = { id: number; name: string; city: string; sheets: string[] };

const projects: Project[] = [
  { id: 24017, name: 'Kita Leingarten', city: 'Leingarten', sheets: ['smartex dm'] },
  { id: 5927, name: 'Müller GmbH', city: 'Heilbronn', sheets: [] },
  { id: 31000, name: 'Tiefgarage Nord', city: 'Stuttgart', sheets: ['smartex wl', 'Leckortung'] },
  { id: 18842, name: 'Rathaus', city: 'Heilbronn', sheets: ['smartex dm'] },
];

const columns: SearchableColumn<Project>[] = [
  { id: 'id', name: 'Project ID', selector: (row) => row.id, sortable: true, width: '110px' },
  { id: 'name', name: 'Name', selector: (row) => row.name, sortable: true },
  { id: 'city', name: 'City', selector: (row) => row.city, sortable: true },
  {
    id: 'sheets',
    name: 'Product sheets',
    // The cell renders the list, the selector has nothing to search.
    searchText: (row) => row.sheets.join(' '),
    cell: (row) => <span {...ROW_CLICK}>{row.sheets.join(', ') || '-'}</span>,
  },
];

const meta: Meta<typeof SearchableDataTable<Project, number>> = {
  title: 'Kit/SearchableDataTable',
  component: SearchableDataTable,
};
export default meta;

type Story = StoryObj<typeof SearchableDataTable<Project, number>>;

export const Default: Story = {
  render: () => <SearchableDataTable columns={columns} data={projects} keyField="id" defaultSortFieldId="id" dense />,
};

export const WithSelection: Story = {
  render: () => {
    const [selected, setSelected] = useState<Set<number>>(new Set([5927]));
    return (
      <>
        <SearchableDataTable
          columns={columns}
          data={projects}
          keyField="id"
          defaultSortFieldId="id"
          selection={{ rowKey: (row) => row.id, selected, onChange: setSelected }}
          highlightOnHover
          dense
        />
        <div style={{ marginTop: 10, fontSize: 12.5, color: '#6E6868' }}>
          Selected: {Array.from(selected).join(', ') || 'none'}
        </div>
      </>
    );
  },
};
