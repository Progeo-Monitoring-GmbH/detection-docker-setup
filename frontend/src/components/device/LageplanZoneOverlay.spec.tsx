// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axiosConfig from '../../axiosConfig';
import LageplanZoneOverlay, { type LageplanZonePoint } from './LageplanZoneOverlay';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // CursorTooltip measures itself; jsdom has no ResizeObserver.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const point = (pos: number, x: number, y: number, name: string | null, value = 10): LageplanZonePoint => ({
  pos,
  x,
  y,
  name,
  value,
  threshold: 100,
  meters: [x * 40, y * 30],
});

const POINTS = [point(1, 0.2, 0.25, 'Hauptdach', 12), point(2, 0.6, 0.25, 'Hauptdach', 80), point(3, 0.8, 0.7, null)];

const render = (imageUrl: string | null = null) => {
  act(() => {
    root.render(<LageplanZoneOverlay imageUrl={imageUrl} points={POINTS} height={300} />);
  });
};

const overlay = () => container.querySelector('svg')!;

const hover = (element: Element) => {
  vi.spyOn(container.firstElementChild as HTMLElement, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    top: 0,
    width: 800,
    height: 300,
  } as DOMRect);
  act(() => {
    element.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 200, clientY: 150 }));
  });
};

describe('LageplanZoneOverlay alignment', () => {
  it('uses the natural size of the plan image as coordinate system', async () => {
    vi.spyOn(axiosConfig, 'perform_get').mockImplementation(async (_auth, _url, onSuccess) => {
      onSuccess({ data: new Blob(['png'], { type: 'image/png' }) });
    });
    render('media/uploads/lageplan/demo_dfh.png');
    await vi.waitFor(() => expect(container.querySelector('img')).not.toBeNull());

    const image = container.querySelector('img')!;
    Object.defineProperty(image, 'naturalWidth', { value: 1600 });
    Object.defineProperty(image, 'naturalHeight', { value: 1200 });
    act(() => {
      image.dispatchEvent(new Event('load'));
    });

    expect(overlay().getAttribute('viewBox')).toBe('0 0 1600 1200');
    // nx/ny on the 1600x1200 image - not squeezed into a square
    // (the unnamed single point is drawn first, then the zone).
    const centres = Array.from(container.querySelectorAll('[data-testid="zone-point"]')).map(
      (circle) => [circle.getAttribute('cx'), circle.getAttribute('cy')],
    );
    expect(centres).toEqual([['1280', '840'], ['320', '300'], ['960', '300']]);
  });
});

describe('LageplanZoneOverlay tooltips', () => {
  it('shows the sensor tooltip when hovering a point', () => {
    render();
    hover(container.querySelectorAll('[data-testid="zone-point"]')[2]);
    expect(container.textContent).toContain('Sensor #2');
    expect(container.textContent).toContain('80');
    expect(container.textContent).toContain('Threshold');
  });

  it('shows the zone tooltip with its highest sensor when hovering a line', () => {
    render();
    hover(container.querySelector('[data-testid="zone-line"]')!);
    expect(container.textContent).toContain('#1, #2');
    expect(container.textContent).toContain('80 (#2)');
  });

  it('hides the tooltip when the cursor leaves', () => {
    render();
    const target = container.querySelectorAll('[data-testid="zone-point"]')[1];
    hover(target);
    expect(container.textContent).toContain('Sensor #1');
    act(() => {
      target.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: container }));
    });
    expect(container.textContent).not.toContain('Sensor #1');
  });
});
