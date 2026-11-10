// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-router', () => ({ useLocation: () => ({ pathname: '/location/5/status' }) }));

const { default: SidebarShell } = await import('./SidebarShell');

let container: HTMLDivElement;
let root: Root;

const render = () =>
  act(() =>
    root.render(
      <SidebarShell
        width={248}
        subtitle="Portal"
        toggleLabel="Menu"
        closeLabel="Close"
        collapseLabel="Collapse sidebar"
        expandLabel="Expand sidebar"
      >
        {({ collapsed }) => <nav data-testid="nav">{collapsed ? 'icons' : 'icons and labels'}</nav>}
      </SidebarShell>,
    ),
  );

const aside = () => container.querySelector('aside')!;
const foldButton = () => container.querySelector('aside button')!;

beforeEach(() => {
  window.localStorage.clear();
  // Desktop width: the sidebar, not the mobile burger.
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('SidebarShell', () => {
  it('folds to its icons and back', () => {
    render();
    expect(aside().dataset.collapsed).toBe('false');
    expect(aside().style.width).toBe('248px');
    expect(container.querySelector('[data-testid="nav"]')!.textContent).toBe('icons and labels');
    expect(foldButton().getAttribute('aria-label')).toBe('Collapse sidebar');

    act(() => (foldButton() as HTMLButtonElement).click());

    expect(aside().dataset.collapsed).toBe('true');
    expect(aside().style.width).toBe('64px');
    expect(container.querySelector('[data-testid="nav"]')!.textContent).toBe('icons');
    expect(foldButton().getAttribute('aria-label')).toBe('Expand sidebar');
    expect(foldButton().getAttribute('aria-expanded')).toBe('false');
  });

  it('remembers the folded sidebar in this browser', () => {
    render();
    act(() => (foldButton() as HTMLButtonElement).click());
    act(() => root.unmount());

    root = createRoot(container);
    render();

    expect(aside().dataset.collapsed).toBe('true');
  });
});
