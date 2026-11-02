// @vitest-environment jsdom
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWheelHint, useZoomWheel, WheelZoomHint } from './wheelZoom';

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
