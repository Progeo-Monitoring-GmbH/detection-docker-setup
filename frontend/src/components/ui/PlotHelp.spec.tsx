// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import PlotHelp from './PlotHelp';

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
  it('shows what the plot displays and how to use it on a click', () => {
    act(() => root.render(<PlotHelp topic="by_sensor" />));
    expect(document.querySelector('.popover')).toBeNull();

    act(() => container.querySelector<HTMLButtonElement>('[data-testid="plot-help-by_sensor"]')!.click());

    const popover = document.querySelector('.popover');
    expect(popover).not.toBeNull();
    expect(popover!.textContent).toContain('plot_help_by_sensor_what');
    expect(popover!.textContent).toContain('plot_help_by_sensor_how');
  });
});
