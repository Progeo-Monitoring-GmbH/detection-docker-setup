// @vitest-environment jsdom
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  keyAction,
  swipeDirection,
  useKeyNavigation,
  useSwipeNavigation,
  type Direction,
} from './useDirectionalNavigation';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const key = (init: KeyboardEventInit, target: EventTarget = document.body) => {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  Object.defineProperty(event, 'target', { value: target });
  return event;
};

describe('keyAction', () => {
  it('reads arrows, letters and Enter', () => {
    expect(keyAction(key({ key: 'ArrowRight' }))).toBe('right');
    expect(keyAction(key({ key: 'ArrowUp' }))).toBe('up');
    expect(keyAction(key({ key: 'R' }))).toBe('r');
    expect(keyAction(key({ key: 'Enter' }))).toBe('enter');
    expect(keyAction(key({ key: 'Shift' }))).toBeNull();
  });

  it('leaves the keys to fields, shortcuts and dialogs', () => {
    expect(
      keyAction(key({ key: 'ArrowLeft' }, document.createElement('input'))),
    ).toBeNull();
    expect(keyAction(key({ key: 'r', ctrlKey: true }))).toBeNull();
    const dialog = document.createElement('div');
    dialog.className = 'modal show';
    document.body.appendChild(dialog);
    expect(keyAction(key({ key: 'ArrowLeft' }))).toBeNull();
    dialog.remove();
  });
});

describe('swipeDirection', () => {
  it('follows the finger: a swipe left asks for the next (right), a swipe up for what is below', () => {
    expect(swipeDirection(-120, 10)).toBe('right');
    expect(swipeDirection(120, -10)).toBe('left');
    expect(swipeDirection(5, -140)).toBe('down');
    expect(swipeDirection(5, 140)).toBe('up');
  });

  it('ignores short and diagonal moves', () => {
    expect(swipeDirection(-30, 0)).toBeNull();
    expect(swipeDirection(-80, 70)).toBeNull();
  });
});

describe('the hooks', () => {
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

  it('calls the handler of a key - only while enabled', () => {
    const right = vi.fn();
    const reviewed = vi.fn();
    const Page = ({ enabled }: { enabled: boolean }) => {
      useKeyNavigation({ right, keys: { r: reviewed } }, enabled);
      return null;
    };

    act(() => root.render(<Page enabled />));
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true }),
      );
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'r', cancelable: true }),
      );
    });
    act(() => root.render(<Page enabled={false} />));
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    });

    expect(right).toHaveBeenCalledTimes(1);
    expect(reviewed).toHaveBeenCalledTimes(1);
  });

  it('reports a touch swipe with the element it started on - a mouse drag is none', () => {
    const swipes: [Direction, string | undefined][] = [];
    const Gallery = () => {
      const ref = useRef<HTMLDivElement | null>(null);
      useSwipeNavigation(ref, (direction, target) =>
        swipes.push([direction, (target as HTMLElement)?.id]),
      );
      return (
        <div ref={ref}>
          <span id="card-2" />
        </div>
      );
    };
    act(() => root.render(<Gallery />));
    const card = container.querySelector('#card-2')!;
    const pointer = (type: string, x: number, pointerType = 'touch') => {
      const event = new Event(type, { bubbles: true }) as PointerEvent;
      Object.assign(event, {
        clientX: x,
        clientY: 100,
        pointerType,
        isPrimary: true,
        pointerId: 1,
      });
      card.dispatchEvent(event);
    };

    pointer('pointerdown', 300);
    pointer('pointerup', 150);
    pointer('pointerdown', 300, 'mouse');
    pointer('pointerup', 150, 'mouse');

    expect(swipes).toEqual([['right', 'card-2']]);
  });
});
