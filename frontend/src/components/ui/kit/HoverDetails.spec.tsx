// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import HoverDetails, { HOVER_OPEN_DELAY_MS } from './HoverDetails';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** jsdom has no PointerEvent - React reads pointerType off the event. */
const pointer = (type: string, pointerType = 'mouse') => {
  const event = new MouseEvent(type, { bubbles: true });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  return event;
};

describe('HoverDetails', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
      root.render(
        <HoverDetails summary="Berechtigungen" testId="details">
          <span>Optionen</span>
        </HoverDetails>,
      ),
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  const details = () =>
    container.querySelector('[data-testid="details"]') as HTMLDetailsElement;
  const summary = () => details().querySelector('summary')!;
  // React listens for pointerenter/leave as pointerover/out on the root.
  const enter = (pointerType = 'mouse') =>
    act(() => {
      details().dispatchEvent(pointer('pointerover', pointerType));
    });
  const leave = () =>
    act(() => {
      details().dispatchEvent(pointer('pointerout'));
    });
  const wait = (ms: number) => act(() => vi.advanceTimersByTime(ms));
  const click = () => act(() => summary().click());

  it('unfolds when the mouse rests on it - and stays open when it leaves', () => {
    enter();
    expect(details().open).toBe(false);
    wait(HOVER_OPEN_DELAY_MS);
    expect(details().open).toBe(true);
    // No folding back on leave: moving to the next card made the dialog flicker.
    leave();
    expect(details().open).toBe(true);
  });

  it('stays closed when the mouse only passes by', () => {
    enter();
    wait(HOVER_OPEN_DELAY_MS / 2);
    leave();
    wait(HOVER_OPEN_DELAY_MS);
    expect(details().open).toBe(false);
  });

  it('a click on the summary folds it, another one unfolds it', () => {
    enter();
    wait(HOVER_OPEN_DELAY_MS);
    click();
    expect(details().open).toBe(false);
    // Still over it: it stays folded until the mouse comes back.
    wait(HOVER_OPEN_DELAY_MS);
    expect(details().open).toBe(false);
    click();
    expect(details().open).toBe(true);
  });

  it('touch opens by tapping only', () => {
    enter('touch');
    wait(HOVER_OPEN_DELAY_MS);
    expect(details().open).toBe(false);
    click();
    expect(details().open).toBe(true);
  });
});
