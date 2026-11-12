// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axiosConfig from '../../axiosConfig';
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

  it('picks calibration points only while M is held', () => {
    mount({ onSaveScale: vi.fn() });
    act(() => button('Calibrate').click());
    press(300, 300);
    press(600, 300);
    expect(container.textContent).not.toContain('px =');
    key('keydown', 'm');
    press(300, 300);
    press(600, 300);
    key('keyup', 'm');
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

  describe('image edits', () => {
    // The 1000 x 500 plan fits the canvas at 0.868, drawn from (16, 83).
    const toImage = (canvasX: number, canvasY: number) => [(canvasX - 16) / 0.868, (canvasY - 83) / 0.868];
    const select = (from: [number, number], to: [number, number]) =>
      act(() => {
        container
          .querySelector('canvas')!
          .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: from[0], clientY: from[1] }));
        window.dispatchEvent(new MouseEvent('mousemove', { clientX: to[0], clientY: to[1] }));
        window.dispatchEvent(new MouseEvent('mouseup'));
      });
    const answer = (lageplan: Record<string, unknown>) =>
      vi
        .spyOn(axiosConfig, 'perform_post')
        .mockImplementation(async (_auth, _url, _data, onSuccess) => onSuccess({ data: { lageplan } }));
    const editProps = () => ({ locationId: 5, lageplanId: 7, onImageEdited: vi.fn(), onSaveScale: vi.fn() });

    it('clears the selected area only on "Apply"', () => {
      const post = answer({ id: 7, url: 'media/uploads/lageplan/new.png' });
      const props = editProps();
      mount(props);
      expect(container.textContent).toContain('Clear an area - fill it white');
      key('keydown', 'c');
      expect(container.textContent).toContain('Clear: drag over the area');
      select([300, 200], [500, 400]);
      expect(post).not.toHaveBeenCalled();

      act(() => button('Apply').click());

      const [[x0, y0], [x1, y1]] = [toImage(300, 200), toImage(500, 400)];
      expect(post).toHaveBeenCalledTimes(1);
      const [, url, data] = post.mock.calls[0];
      expect(url).toBe('/v1/status/measure_points/edit_lageplan/');
      expect(data).toMatchObject({ location_id: 5, lageplan_id: 7, action: 'clear', offset_x: 0, flip_y: true });
      expect(data.x).toBeCloseTo(x0);
      expect(data.y).toBeCloseTo(y0);
      expect(data.width).toBeCloseTo(x1 - x0);
      expect(data.height).toBeCloseTo(y1 - y0);
      expect(props.onImageEdited).toHaveBeenCalledWith({ lageplan: { id: 7, url: 'media/uploads/lageplan/new.png' } });
      // Done: out of the edit mode.
      expect(container.textContent).not.toContain('Clear: drag over the area');
      expect(button('Apply')).toBeUndefined();
    });

    it('takes the moved alignment of a crop', () => {
      answer({ id: 7, offset_x: 42, offset_y: -17, scale_x: 1.5, scale_y: 2, flip_y: true });
      mount(editProps());
      key('keydown', 'x');
      select([300, 200], [500, 400]);

      act(() => button('Apply').click());

      expect(container.textContent).toContain('Offset X42');
      expect(container.textContent).toContain('Offset Y-17');
      expect(container.textContent).toContain('Scale X1.5000');
    });

    it('drops the selection with Escape and pressing the key again', () => {
      const post = answer({ id: 7 });
      mount(editProps());
      key('keydown', 'x');
      select([300, 200], [500, 400]);
      expect(button('Apply')).toBeDefined();
      key('keydown', 'Escape');
      expect(button('Apply')).toBeUndefined();

      key('keydown', 'x');
      select([300, 200], [500, 400]);
      key('keydown', 'x');
      expect(button('Apply')).toBeUndefined();
      expect(post).not.toHaveBeenCalled();
    });

    it('needs a stored plan - without one C and X do nothing', () => {
      mount({ onSaveScale: vi.fn() });
      key('keydown', 'c');
      expect(container.textContent).not.toContain('Clear: drag over the area');
      expect(container.textContent).not.toContain('Edit the image');
    });

    it('shows why an edit failed and keeps the selection', () => {
      vi.spyOn(axiosConfig, 'perform_post').mockImplementation(async (_auth, _url, _data, _ok, onError) =>
        onError?.({ response: { data: { reason: 'Only image Lageplans (PNG, JPEG, ...) can be edited, not .pdf.' } } }),
      );
      mount(editProps());
      key('keydown', 'x');
      select([300, 200], [500, 400]);

      act(() => button('Apply').click());

      expect(container.textContent).toContain('Could not crop the plan: Only image Lageplans');
      expect(button('Apply')).toBeDefined();
    });
  });

  describe('removing measure points', () => {
    // As in 'image edits': image pixel (x, y) is drawn at (16 + 0.868 x, 83 + 0.868 y);
    // flipped (the default), ny = 0.6 is image y = 200.
    const points = [
      { id: 11, sensor_order: 1, nx: 0.3, ny: 0.6 }, // canvas (276, 257)
      { id: 12, sensor_order: 2, nx: 0.8, ny: 0.2 }, // canvas (710, 430)
      { id: 13, sensor_order: 3, nx: 0.35, ny: 0.55 }, // canvas (320, 278)
    ];
    const select = (from: [number, number], to: [number, number]) =>
      act(() => {
        container
          .querySelector('canvas')!
          .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: from[0], clientY: from[1] }));
        window.dispatchEvent(new MouseEvent('mousemove', { clientX: to[0], clientY: to[1] }));
        window.dispatchEvent(new MouseEvent('mouseup'));
      });

    it('removes the points in the area dragged with D held, only on "Remove"', () => {
      const post = vi
        .spyOn(axiosConfig, 'perform_post')
        .mockImplementation(async (_auth, _url, _data, onSuccess) => onSuccess({ data: { point_ids: [11, 13] } }));
      const onPointsRemoved = vi.fn();
      mount({ locationId: 5, measurePoints: points, onPointsRemoved });
      expect(container.textContent).toContain('Hold D, drag over measure points to remove them');

      key('keydown', 'd');
      select([250, 230], [350, 300]);
      key('keyup', 'd');
      expect(container.textContent).toContain('Remove: 2 measure point(s) selected');
      expect(post).not.toHaveBeenCalled();

      act(() => button('Remove 2').click());

      expect(post).toHaveBeenCalledTimes(1);
      const [, url, data] = post.mock.calls[0];
      expect(url).toBe('/v1/status/measure_points/remove/');
      expect(data).toEqual({ location_id: 5, point_ids: [11, 13] });
      expect(onPointsRemoved).toHaveBeenCalledWith({ point_ids: [11, 13] });
      expect(container.textContent).not.toContain('Remove: ');
    });

    it('offers nothing to remove for an empty area, and a plain drag still pans', () => {
      const post = vi.spyOn(axiosConfig, 'perform_post');
      mount({ locationId: 5, measurePoints: points, onPointsRemoved: vi.fn() });

      select([100, 100], [150, 150]);
      expect(button('Remove 0')).toBeUndefined();

      key('keydown', 'd');
      select([100, 100], [150, 150]);
      key('keyup', 'd');
      expect(button('Remove 0').disabled).toBe(true);
      key('keydown', 'Escape');
      expect(button('Remove 0')).toBeUndefined();
      expect(post).not.toHaveBeenCalled();
    });

    it('is not offered without onPointsRemoved', () => {
      mount({ locationId: 5, measurePoints: points });
      expect(container.textContent).not.toContain('Hold D');
    });

    // One event per act: the handlers read the state the last one left.
    const canvasEvent = (type: string, clientX: number, clientY: number) =>
      act(() => {
        container.querySelector('canvas')!.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX, clientY }));
      });
    const placed = () =>
      vi
        .spyOn(axiosConfig, 'perform_post')
        .mockImplementation(async (_auth, _url, data, onSuccess) =>
          onSuccess({ data: { points: (data as { points: unknown[] }).points } }),
        );

    it('cuts out the points dragged over with O held - nothing is stored', () => {
      const post = vi.spyOn(axiosConfig, 'perform_post');
      const onCut = vi.fn();
      mount({ locationId: 5, lageplanId: 7, measurePoints: points, onCut });

      key('keydown', 'o');
      select([250, 230], [350, 300]);
      key('keyup', 'o');
      act(() => button('Cut 2').click());

      expect(onCut).toHaveBeenCalledWith([points[0], points[2]]);
      expect(post).not.toHaveBeenCalled();
    });

    it('inserts the cut points with I + click, their middle at the click', () => {
      const post = placed();
      const onPointsPlaced = vi.fn();
      mount({ locationId: 5, lageplanId: 7, cutPoints: [points[0], points[2]], onPointsPlaced });
      expect(container.textContent).toContain('2 measure point(s) cut out');

      key('keydown', 'i');
      // The plan's middle: image pixel (500, 250) - nx 0.5, ny 0.5 (flipped).
      canvasEvent('mousemove', 450, 300);
      expect(container.textContent).toContain('Insert 2 cut measure point(s)');
      canvasEvent('mousedown', 450, 300);
      key('keyup', 'i');

      const [, url, data] = post.mock.calls[0];
      expect(url).toBe('/v1/status/measure_points/place/');
      const sent = data as { location_id: number; lageplan_id: number; points: Array<Record<string, number>> };
      expect([sent.location_id, sent.lageplan_id]).toEqual([5, 7]);
      // Their middle (0.325, 0.575) went to (0.5, 0.5).
      expect(sent.points.map((point) => point.id)).toEqual([11, 13]);
      expect(sent.points[0].nx).toBeCloseTo(0.475);
      expect(sent.points[0].ny).toBeCloseTo(0.525);
      expect(sent.points[1].nx).toBeCloseTo(0.525);
      expect(sent.points[1].ny).toBeCloseTo(0.475);
      expect(onPointsPlaced).toHaveBeenCalledWith({ points: sent.points }, 'insert');
    });

    it('aligns the points selected with L by themselves', () => {
      const post = placed();
      const onPointsPlaced = vi.fn();
      mount({ locationId: 5, lageplanId: 7, measurePoints: points, onPointsPlaced });

      key('keydown', 'l');
      select([250, 230], [350, 300]);
      key('keyup', 'l');
      act(() => button('Align 2').click());
      expect(container.textContent).toContain('Aligning 2 measure point(s) by themselves · 0 pinned');

      // Point 11 (canvas 276.4, 256.6) dragged 100 canvas units to the right.
      canvasEvent('mousedown', 276.4, 256.6);
      canvasEvent('mousemove', 376.4, 256.6);
      canvasEvent('mouseup', 376.4, 256.6);
      expect(container.textContent).toContain('1 pinned');
      act(() => button('Apply').click());

      const [, url, data] = post.mock.calls[0];
      expect(url).toBe('/v1/status/measure_points/place/');
      const sent = (data as { points: Array<Record<string, number>> }).points;
      // Both moved by 100 / 868 of the plan's width, point 12 not at all.
      expect(sent.map((point) => point.id)).toEqual([11, 13]);
      expect(sent[0].nx).toBeCloseTo(0.3 + 100 / 868);
      expect(sent[0].ny).toBeCloseTo(0.6);
      expect(sent[1].nx).toBeCloseTo(0.35 + 100 / 868);
      expect(onPointsPlaced).toHaveBeenCalledWith({ points: sent }, 'align');
      expect(container.textContent).not.toContain('by themselves');
    });
  });
});
