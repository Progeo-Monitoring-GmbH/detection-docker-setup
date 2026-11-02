// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ImageCanvasStage from './ImageCanvasStage';

// One auth object - a new one each render would reload the image each time.
const auth = vi.hoisted(() => ({}));
vi.mock('../../../hooks/CoreAuthProvider', () => ({ useAuth: () => auth }));

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
    expect(container.textContent).toContain('Ctrl + scroll to zoom');
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

describe('ImageCanvasStage alignment and scale', () => {
  // jsdom loads no images - this one is there at once.
  class LoadedImage {
    naturalWidth = 1000;
    naturalHeight = 500;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_value: string) {
      this.onload?.();
    }
  }

  let mountKey = 0;
  const mount = (props: Parameters<typeof ImageCanvasStage>[0]) => {
    mountKey += 1;
    act(() =>
      root.render(
        <ImageCanvasStage key={mountKey} imageUrl="data:image/png;base64,AA" withSliders {...props} />,
      ),
    );
    vi.spyOn(container.querySelector('canvas')!, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 900,
      height: 600,
    } as DOMRect);
  };
  const press = (clientX = 450, clientY = 300) =>
    act(() => {
      container
        .querySelector('canvas')!
        .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX, clientY }));
      window.dispatchEvent(new MouseEvent('mouseup'));
    });
  const key = (type: 'keydown' | 'keyup', value: string) =>
    act(() => {
      window.dispatchEvent(new KeyboardEvent(type, { key: value }));
    });
  const button = (label: string) =>
    [...container.querySelectorAll('button')].find((item) => item.textContent === label)!;

  beforeEach(() => {
    vi.stubGlobal('Image', LoadedImage);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('sets the reference point while R is held', () => {
    mount({ onSaveScale: vi.fn() });
    press();
    expect(container.textContent).toContain('not set');
    key('keydown', 'r');
    press();
    key('keyup', 'r');
    expect(container.textContent).toMatch(/at pixel \(\d+, \d+\)/);
  });

  it('picks calibration points only while C is held', () => {
    mount({ onSaveScale: vi.fn() });
    act(() => button('Calibrate').click());
    press(300, 300);
    press(600, 300);
    expect(container.textContent).not.toContain('px =');
    key('keydown', 'c');
    press(300, 300);
    press(600, 300);
    key('keyup', 'c');
    expect(container.textContent).toMatch(/\d+\.\d px =/);
  });

  it('stores the alignment by itself and keeps it when the scale is stored', () => {
    vi.useFakeTimers();
    const onSaveSliders = vi.fn();
    mount({ onSaveSliders, onSaveScale: vi.fn(), sourceMeta: { flip_y: true } });
    act(() => button('Vertical flip').click());
    expect(onSaveSliders).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(600));
    expect(onSaveSliders).toHaveBeenCalledWith({ offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1, flipY: false });

    // The stored scale comes back on the plan - the alignment stays.
    act(() =>
      root.render(
        <ImageCanvasStage
          key={mountKey}
          imageUrl="data:image/png;base64,AA"
          withSliders
          onSaveSliders={onSaveSliders}
          onSaveScale={vi.fn()}
          sourceMeta={{ flip_y: true, reference_x: 10, reference_y: 20 }}
        />,
      ),
    );
    expect(button('Vertical flip').getAttribute('aria-pressed')).toBe('false');
    act(() => vi.advanceTimersByTime(600));
    expect(onSaveSliders).toHaveBeenCalledTimes(1);
  });

  it('stores a pending alignment when the plan is left', () => {
    vi.useFakeTimers();
    const onSaveSliders = vi.fn();
    mount({ onSaveSliders, sourceMeta: { flip_y: true } });
    act(() => button('Vertical flip').click());
    act(() => root.render(<ImageCanvasStage />));
    expect(onSaveSliders).toHaveBeenCalledWith(expect.objectContaining({ flipY: false }));
  });
});
