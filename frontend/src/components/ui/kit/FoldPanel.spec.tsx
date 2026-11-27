// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FoldPanel from './FoldPanel';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// The setters of every Targeted render - collected, not assigned during render.
const setters: ((value: boolean) => void)[] = [];
const target = (value: boolean) => setters[setters.length - 1](value);
const Targeted = () => {
  const [targeted, setTargeted] = useState(false);
  setters.push(setTargeted);
  return (
    <FoldPanel title="Lageplan" testId="panel" openOn={targeted}>
      <input data-testid="panel-field" />
    </FoldPanel>
  );
};

describe('FoldPanel', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    // The Collapse ends its slide on a timer (dom-helpers' transitionEnd
    // fallback) - run here, it would fire after jsdom is gone.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => vi.runOnlyPendingTimers());
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  const toggle = () =>
    container.querySelector<HTMLButtonElement>('[data-testid="fold-toggle"][data-test-key="panel"]')!;
  const body = () => document.getElementById(toggle().getAttribute('aria-controls')!)!;

  it('is folded by default - the hint shows, the body stays mounted but hidden', () => {
    act(() =>
      root.render(
        <FoldPanel title="SMTP" hint="Used for mails." actions={<span data-testid="panel-count">2</span>} testId="panel">
          <input data-testid="panel-field" />
        </FoldPanel>,
      ),
    );
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(toggle().textContent).toContain('SMTP');
    expect(container.querySelector('[data-testid="panel-hint"]')?.textContent).toBe('Used for mails.');
    expect(container.querySelector('[data-testid="panel-count"]')).not.toBeNull();
    expect(body().classList.contains('show')).toBe(false);
    expect(body().querySelector('[data-testid="panel-field"]')).not.toBeNull();
  });

  it('unfolds and folds on a click of its header', () => {
    act(() =>
      root.render(
        <FoldPanel title="SMTP" testId="panel">
          <input data-testid="panel-field" />
        </FoldPanel>,
      ),
    );
    act(() => toggle().click());
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('[data-testid="panel"]')?.classList.contains('progeo-fold--open')).toBe(true);
    act(() => toggle().click());
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
  });

  it('starts unfolded with defaultOpen, unfolds when openOn turns true', () => {
    act(() =>
      root.render(
        <FoldPanel title="SMTP" testId="panel" defaultOpen>
          <span />
        </FoldPanel>,
      ),
    );
    expect(toggle().getAttribute('aria-expanded')).toBe('true');

    act(() => root.render(<Targeted />));
    // A new panel (another component) - folded again.
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    act(() => target(true));
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
  });
});
