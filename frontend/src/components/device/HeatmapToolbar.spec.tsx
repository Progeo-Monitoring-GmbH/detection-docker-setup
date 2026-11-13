// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import HeatmapToolbar from './HeatmapToolbar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const VIDEO = {
  exporting: false,
  stage: null,
  progress: 0,
  resultUrl: null,
  download: async () => undefined,
  start: async () => undefined,
  enabled: true,
};

const render = (sigma?: { value: 'auto' | number; onChange: (sigma: 'auto' | number) => void }) =>
  act(() =>
    root.render(<HeatmapToolbar plans={null} planIndex={0} onPlanChange={() => undefined} sigma={sigma} video={VIDEO} />),
  );

const byTestId = (id: string) => container.querySelector(`[data-testid="${id}"]`);

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('HeatmapToolbar σ', () => {
  it('shows no σ controls without `sigma` (users who are not staff)', () => {
    render();
    expect(byTestId('heatmap-toolbar-auto-sigma')).toBeNull();
    expect(byTestId('heatmap-toolbar-sigma')).toBeNull();
  });

  it('shows the stored σ to staff and reports a change', () => {
    const onChange = vi.fn();
    render({ value: 0.06, onChange });
    const auto = byTestId('heatmap-toolbar-auto-sigma') as HTMLInputElement;
    expect(auto.checked).toBe(false);
    expect(byTestId('heatmap-toolbar-sigma-value')?.textContent).toContain('0.060');

    act(() => auto.click());
    expect(onChange).toHaveBeenCalledWith('auto');
  });

  it('hides the slider with Auto σ', () => {
    render({ value: 'auto', onChange: () => undefined });
    expect((byTestId('heatmap-toolbar-auto-sigma') as HTMLInputElement).checked).toBe(true);
    expect(byTestId('heatmap-toolbar-sigma')).toBeNull();
  });
});
