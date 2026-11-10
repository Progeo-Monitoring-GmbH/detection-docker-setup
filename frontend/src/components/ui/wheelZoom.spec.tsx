// @vitest-environment jsdom
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PlotlyTouchScroll,
  TWO_FINGER_TOUCH_ACTION,
  useTwoFingerTouch,
  useWheelHint,
  useZoomWheel,
  WheelZoomHint,
} from './wheelZoom';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const zooms: number[] = [];

const Zoomable = () => {
  const ref = useRef<HTMLDivElement | null>(null);
  const [hint, showHint] = useWheelHint();
  useZoomWheel(ref, (event) => zooms.push(event.deltaY), showHint);
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <WheelZoomHint visible={hint} />
    </div>
  );
};

beforeEach(() => {
  vi.useFakeTimers();
  zooms.length = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<Zoomable />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

const wheel = (init: WheelEventInit) => {
  const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100, ...init });
  act(() => {
    container.firstElementChild!.dispatchEvent(event);
  });
  return event;
};

describe('useZoomWheel', () => {
  it('zooms with Ctrl or ⌘ + wheel and keeps the page and browser from it', () => {
    expect(wheel({ ctrlKey: true }).defaultPrevented).toBe(true);
    expect(wheel({ metaKey: true, deltaY: 50 }).defaultPrevented).toBe(true);
    expect(zooms).toEqual([-100, 50]);
  });

  it('lets the plain wheel scroll the page and shows how to zoom for a moment', () => {
    expect(wheel({}).defaultPrevented).toBe(false);
    expect(zooms).toEqual([]);
    expect(container.textContent).toBe('Ctrl + scroll to zoom');
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(container.textContent).toBe('');
  });
});

/** A touch event with `count` fingers (jsdom has no Touch constructor). */
const touch = (type: string, count: number, target: Element) => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'touches', { value: Array.from({ length: count }, () => ({})) });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
};

describe('useTwoFingerTouch', () => {
  const Plan = () => {
    const ref = useRef<HTMLDivElement | null>(null);
    const [hint, showHint] = useWheelHint();
    useTwoFingerTouch(ref, () => showHint('touch'));
    return (
      <div ref={ref} style={{ position: 'relative', touchAction: TWO_FINGER_TOUCH_ACTION }}>
        <WheelZoomHint visible={hint} />
      </div>
    );
  };

  beforeEach(() => {
    act(() => root.render(<Plan />));
  });

  it('keeps two fingers from scrolling the page - they move the plan', () => {
    expect(touch('touchmove', 2, container.firstElementChild!).defaultPrevented).toBe(true);
    expect(container.textContent).toBe('');
  });

  it('lets one finger scroll the page and shows how to move the plan', () => {
    expect(touch('touchmove', 1, container.firstElementChild!).defaultPrevented).toBe(false);
    expect(container.textContent).toBe('Use two fingers to move and zoom');
  });
});

describe('usePlotlyTouchScroll', () => {
  it('keeps one-finger touches from Plotly (it would stop the page scroll), two reach it', () => {
    const reached: number[] = [];
    act(() =>
      root.render(
        <PlotlyTouchScroll>
          <div className="drag" />
        </PlotlyTouchScroll>,
      ),
    );
    // Like Plotly's drag layer: a touchstart listener that prevents the default.
    const dragLayer = container.querySelector('.drag')!;
    dragLayer.addEventListener('touchstart', (event) => {
      reached.push((event as TouchEvent).touches.length);
      event.preventDefault();
    });

    const oneFinger = touch('touchstart', 1, dragLayer);
    const twoFingers = touch('touchstart', 2, dragLayer);

    expect(reached).toEqual([2]);
    expect(oneFinger.defaultPrevented).toBe(false);
    expect(twoFingers.defaultPrevented).toBe(true);
  });
});
