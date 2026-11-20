// @vitest-environment jsdom
import { act, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  keyAction,
  swipeDirection,
  useKeyNavigation,
  useSwipeNavigation,
  useTouchSwipe,
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

  it('in a dialog: its own keys - only a dialog over it takes them', () => {
    const dialog = document.createElement('div');
    dialog.className = 'modal show';
    document.body.appendChild(dialog);
    expect(keyAction(key({ key: 'ArrowLeft' }), true)).toBe('left');
    const confirm = document.createElement('div');
    confirm.className = 'modal show';
    document.body.appendChild(confirm);
    expect(keyAction(key({ key: 'ArrowLeft' }), true)).toBeNull();
    confirm.remove();
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

  it('touch swipes: tells whether the strip under the finger scrolled; two fingers are none', () => {
    const swipes: [Direction, boolean][] = [];
    const Viewer = () => {
      const [element, setElement] = useState<HTMLDivElement | null>(null);
      useTouchSwipe(element, (direction, { scrolled }) =>
        swipes.push([direction, scrolled]),
      );
      return (
        <div ref={setElement}>
          <div id="strip">
            <span id="part" />
          </div>
        </div>
      );
    };
    act(() => root.render(<Viewer />));
    const strip = container.querySelector<HTMLElement>('#strip')!;
    // Wider than shown (jsdom lays nothing out).
    Object.defineProperty(strip, 'scrollWidth', { value: 800 });
    Object.defineProperty(strip, 'clientWidth', { value: 300 });
    const part = container.querySelector('#part')!;
    const touchEvent = (type: string, x: number, fingers = 1) => {
      const event = new Event(type, { bubbles: true }) as TouchEvent;
      const point = { clientX: x, clientY: 100 };
      Object.assign(event, {
        touches: type === 'touchend' ? [] : Array(fingers).fill(point),
        changedTouches: [point],
      });
      part.dispatchEvent(event);
    };

    // At the strip's end: a step on.
    touchEvent('touchstart', 300);
    touchEvent('touchend', 150);
    // The strip scrolled with the finger: no step.
    touchEvent('touchstart', 300);
    strip.scrollLeft = 120;
    touchEvent('touchend', 150);
    // A pinch.
    touchEvent('touchstart', 300, 2);
    touchEvent('touchend', 150);

    expect(swipes).toEqual([
      ['right', false],
      ['right', true],
    ]);
  });
});
