// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AirtableSync } from './AirtableSyncPanel';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../axiosConfig', () => ({ default: { perform_post: vi.fn() } }));
vi.mock('../../../hooks/CoreAuthProvider', () => ({ useAuth: () => ({}) }));
vi.mock('notistack', () => ({
  useSnackbar: () => ({ enqueueSnackbar: vi.fn() }),
}));

const { default: AirtableSyncPanel } = await import('./AirtableSyncPanel');

const project = (projectId: number, status: string | null) => ({
  project_id: projectId,
  name: `Objekt ${projectId}`,
  airtable_type: 'smartex',
  project_type_label: 'smartex® dm',
  status,
  product_sheets: [],
  airtable_url: null,
  raw_address: '',
});

const SYNC: AirtableSync = {
  available: [
    project(7003, 'Messeinheit und Inbetriebnahme'),
    project(7001, 'Sensorik'),
    project(7002, 'Technischer Planung'),
  ],
  updated: [],
  unchanged: 0,
  signed: 'signed',
  accounts: [{ id: 1, name: 'ProGeo' }],
};

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

const statuses = () =>
  [...container.querySelectorAll('[data-testid="airtable-sync-status"]')].map(
    (cell) => [cell.getAttribute('data-test-key'), cell.textContent],
  );

describe('AirtableSyncPanel', () => {
  it('shows the Airtable status of every project and sorts by it in pipeline order', () => {
    act(() =>
      root.render(
        <AirtableSyncPanel
          initial={SYNC}
          onClose={() => {}}
          onLocationsChanged={() => {}}
        />,
      ),
    );

    expect(statuses()).toEqual([
      ['7001', 'Sensorik'],
      ['7002', 'Technischer Planung'],
      ['7003', 'Messeinheit und Inbetriebnahme'],
    ]);
    expect(
      container.querySelector(
        '[data-test-key="7002"][data-testid="airtable-sync-status"]',
      )!.className,
    ).toContain('airtable-sync-status--planning');

    const header = [
      ...container.querySelectorAll('[role="columnheader"]'),
    ].find((cell) => cell.textContent === 'Status')!;
    act(() =>
      header.querySelector<HTMLElement>('.rdt_TableCol_Sortable')!.click(),
    );

    expect(statuses().map(([id]) => id)).toEqual(['7002', '7001', '7003']);
  });
});
