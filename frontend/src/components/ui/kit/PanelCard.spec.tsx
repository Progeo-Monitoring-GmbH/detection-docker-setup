// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PanelCard from './PanelCard';
import { duplicateTestIds } from '../../../testIds';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A panel higher than 250px folds (jsdom has no layout: the height is set here). */

let height = 0;
let container: HTMLDivElement;
let root: Root;

const toggle = () => container.querySelector<HTMLButtonElement>('[data-testid="fold-toggle"]');
// The Collapse: "show" while unfolded.
const shown = () => container.querySelector<HTMLElement>('.progeo-panel-fold-body')!.classList.contains('show');

beforeEach(() => {
  height = 0;
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(() => height);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('PanelCard folding', () => {
  it('offers no toggle for a low panel', () => {
    height = 250;
    act(() => root.render(<PanelCard title="Low" testId="low">x</PanelCard>));

    expect(toggle()).toBeNull();
    expect(shown()).toBe(true);
  });

  it('folds a panel higher than 250px, unfolded first, its body kept mounted', () => {
    height = 251;
    act(() =>
      root.render(
        <PanelCard title="High" testId="high">
          <input defaultValue="" data-testid="kept" />
        </PanelCard>,
      ),
    );

    expect(toggle()?.getAttribute('aria-expanded')).toBe('true');
    expect(toggle()?.getAttribute('data-test-key')).toBe('high');
    expect(shown()).toBe(true);

    const input = container.querySelector<HTMLInputElement>('[data-testid="kept"]')!;
    input.value = 'typed';
    height = 50; // folded it is low - the toggle stays
    act(() => toggle()!.click());

    expect(toggle()?.getAttribute('aria-expanded')).toBe('false');
    expect(shown()).toBe(false);
    expect(container.querySelector<HTMLInputElement>('[data-testid="kept"]')?.value).toBe('typed');

    act(() => toggle()!.click());

    expect(toggle()?.getAttribute('aria-expanded')).toBe('true');
  });

  it('never folds without a title, inside another panel or when told not to', () => {
    height = 900;
    act(() =>
      root.render(
        <>
          <PanelCard testId="untitled">x</PanelCard>
          <PanelCard title="Flat" flat testId="flat">
            x
          </PanelCard>
          <PanelCard title="Own" foldable={false} testId="own">
            x
          </PanelCard>
        </>,
      ),
    );

    expect(toggle()).toBeNull();
  });

  it('lets the page keep the fold state, and tells two panels apart', () => {
    const onToggle = vi.fn();
    act(() =>
      root.render(
        <>
          <PanelCard title="A" foldable open={false} onToggle={onToggle} testId="a">
            x
          </PanelCard>
          <PanelCard title="B" foldable>
            x
          </PanelCard>
        </>,
      ),
    );

    expect(shown()).toBe(false);
    act(() => toggle()!.click());
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(shown()).toBe(false); // the page decides
    expect(duplicateTestIds(container)).toEqual([]);
  });
});
