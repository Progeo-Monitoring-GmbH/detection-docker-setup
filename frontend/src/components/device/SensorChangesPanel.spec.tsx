// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SensorChangesPanel, { CHANGES_PAGE } from './SensorChangesPanel';
import type { SensorChange } from './measurementBands';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const change = (sensor: number): SensorChange => ({
  sensor,
  wpThen: 0,
  wpNow: 30 - sensor,
  epThen: 0,
  epNow: 0,
  wpChange: 30 - sensor,
  epChange: 0,
});

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
});

const rows = () => container.querySelectorAll('tbody tr');
const moreButton = () => container.querySelector('button');

describe('SensorChangesPanel', () => {
  it(`shows ${CHANGES_PAGE} changes, more on demand`, () => {
    const changes = Array.from({ length: 23 }, (_, sensor) => change(sensor));
    act(() => root.render(<SensorChangesPanel changes={changes} wpColor="green" epColor="yellow" />));
    expect(rows()).toHaveLength(CHANGES_PAGE);
    expect(rows()[0].textContent).toContain('+30.00');

    act(() => moreButton()!.click());
    expect(rows()).toHaveLength(2 * CHANGES_PAGE);
    act(() => moreButton()!.click());
    expect(rows()).toHaveLength(23);
    expect(moreButton()).toBeNull();
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
    act(() => (rows()[0] as HTMLElement).click());
    expect(onSensorSelect).toHaveBeenCalledWith(4);
    expect(rows()[1].getAttribute('aria-selected')).toBe('true');
    expect(moreButton()).toBeNull();
  });
});
