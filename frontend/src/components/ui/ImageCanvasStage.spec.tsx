// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ImageCanvasStage from './ImageCanvasStage';

vi.mock('../../../hooks/CoreAuthProvider', () => ({ useAuth: () => ({}) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // jsdom draws nothing - the canvas only needs to exist.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<ImageCanvasStage />));
  vi.spyOn(container.querySelector('canvas')!, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    top: 0,
    width: 900,
    height: 600,
  } as DOMRect);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

const wheel = (init: WheelEventInit) => {
  const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: 450, clientY: 300, ...init });
  act(() => {
    container.querySelector('canvas')!.dispatchEvent(event);
  });
  return event;
};

describe('ImageCanvasStage zoom', () => {
  it('leaves the plain wheel to the page and tells how to zoom', () => {
    const event = wheel({ deltaY: -100 });
    expect(event.defaultPrevented).toBe(false);
    expect(container.textContent).toContain('Zoom 1.00×');
    expect(container.textContent).toContain('Ctrl + scroll to zoom the plan');
  });

  it('zooms with Ctrl + wheel', () => {
    const event = wheel({ deltaY: -100, ctrlKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(container.textContent).toContain('Zoom 1.16×');
  });

  it('zooms with the buttons in the corner and resets', () => {
    // ZoomControls: in, out, reset - top to bottom.
    const [zoomIn, , reset] = container.querySelectorAll<HTMLButtonElement>('.btn-group-vertical button');
    expect(reset.disabled).toBe(true);
    act(() => zoomIn.click());
    expect(container.textContent).toContain('Zoom 1.50×');
    act(() => reset.click());
    expect(container.textContent).toContain('Zoom 1.00×');
  });
});
