// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SensorChangesPanel, { CHANGES_PAGE, percentChange } from './SensorChangesPanel';
import type { SensorChange } from './measurementBands';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** WP from 100 to 130 - sensor (+30 % ... ), EP from 50 to 40 (-20 %). */
const change = (sensor: number): SensorChange => ({
  sensor,
  wpThen: 100,
  wpNow: 130 - sensor,
  epThen: 50,
  epNow: 40,
  wpChange: 30 - sensor,
  epChange: -10,
});

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
  // ...and its pagination watches its width.
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

const bodyRows = () => Array.from(container.querySelectorAll('.rdt_TableBody .rdt_TableRow'));
const header = (index: number) => container.querySelectorAll('.rdt_TableCol_Sortable')[index] as HTMLElement;

describe('percentChange', () => {
  it('is the change in percent of the old value, null without one', () => {
    expect(percentChange(100, 130)).toBe(30);
    expect(percentChange(50, 40)).toBe(-20);
    expect(percentChange(-50, -40)).toBe(20);
    expect(percentChange(0, 5)).toBeNull();
  });
});

describe('SensorChangesPanel', () => {
  it(`pages ${CHANGES_PAGE} changes and shows them in percent, plus green and minus red`, () => {
    const changes = Array.from({ length: 23 }, (_, sensor) => change(sensor));
    act(() => root.render(<SensorChangesPanel changes={changes} wpColor="green" epColor="yellow" />));

    expect(bodyRows()).toHaveLength(CHANGES_PAGE);
    const [wp, ep] = Array.from(bodyRows()[0].querySelectorAll('span[style*="tabular-nums"]')) as HTMLElement[];
    expect(wp.textContent).toBe('+30.0 %');
    expect(wp.style.color).toBe('rgb(63, 122, 28)');
    expect(ep.textContent).toBe('−20.0 %');
    expect(ep.style.color).toBe('rgb(196, 77, 38)');
  });

  it('sorts by a column', () => {
    act(() =>
      root.render(<SensorChangesPanel changes={[change(4), change(1), change(7)]} wpColor="green" epColor="yellow" />),
    );
    // WP, ascending: the smallest increase (sensor 8, +23 %) first.
    act(() => header(1).click());
    expect(bodyRows()[0].textContent).toContain('+23.0 %');
  });

  it('reports a clicked sensor and marks the selected ones', () => {
    const onSensorSelect = vi.fn();
    act(() =>
      root.render(
        <SensorChangesPanel
          changes={[change(4), change(7)]}
          wpColor="green"
          epColor="yellow"
          selectedSensors={[7]}
          onSensorSelect={onSensorSelect}
        />,
      ),
    );
    act(() => (bodyRows()[0].querySelector('[data-tag="allowRowEvents"]') as HTMLElement).click());
    expect(onSensorSelect).toHaveBeenCalledWith(4);
    expect(bodyRows()[1].querySelector('svg')).not.toBeNull();
    expect(bodyRows()[0].querySelector('svg')).toBeNull();
  });
});
