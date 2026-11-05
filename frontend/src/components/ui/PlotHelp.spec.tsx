// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import PlotHelp, { helpLines } from './PlotHelp';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

describe('PlotHelp', () => {
  it('shows what the plot displays, its actions and workflows on a click', () => {
    act(() => root.render(<PlotHelp topic="by_sensor" />));
    expect(document.querySelector('.popover')).toBeNull();

    act(() => container.querySelector<HTMLButtonElement>('[data-testid="plot-help-by_sensor"]')!.click());

    const popover = document.querySelector('.popover');
    expect(popover).not.toBeNull();
    expect(popover!.textContent).toContain('plot_help_by_sensor_what');
    expect(popover!.textContent).toContain('plot_help_by_sensor_actions');
    expect(popover!.textContent).toContain('plot_help_by_sensor_workflows');
  });
});

describe('helpLines', () => {
  it('splits one statement per line into a bold lead and the rest', () => {
    expect(helpLines('Click a sensor::show it\n\n  Hover :: values \nplain line')).toEqual([
      { lead: 'Click a sensor', rest: 'show it' },
      { lead: 'Hover', rest: 'values' },
      { lead: '', rest: 'plain line' },
    ]);
  });

  it('keeps a |WP − EP| in the text (no separator)', () => {
    expect(helpLines('the |WP − EP| of all sensors')).toEqual([{ lead: '', rest: 'the |WP − EP| of all sensors' }]);
  });
});
