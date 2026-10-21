// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axiosConfig from '../../axiosConfig';
import LageplanZoneOverlay, {
  convexHull,
  segmentPadding,
  type LageplanOverlayMode,
  type LageplanZonePoint,
} from './LageplanZoneOverlay';

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

const render = (
  imageUrl: string | null = null,
  mode?: LageplanOverlayMode,
  points: LageplanZonePoint[] = POINTS,
) => {
  act(() => {
    root.render(<LageplanZoneOverlay imageUrl={imageUrl} points={points} height={300} mode={mode} />);
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
    render('media/uploads/lageplan/demo_smartex_is.png');
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
  it('shows the sensor tooltip when hovering a sensor of no line', () => {
    render(null, 'lines', [...POINTS.slice(0, 2), point(3, 0.8, 0.7, null, 55)]);
    hover(container.querySelectorAll('[data-testid="zone-point"]')[0]);
    expect(container.textContent).toContain('Sensor #3');
    expect(container.textContent).toContain('55');
    expect(container.textContent).toContain('Threshold');
  });

  it('shows the line when hovering one of its sensors', () => {
    render();
    hover(container.querySelectorAll('[data-testid="zone-point"]')[1]);
    expect(container.textContent).toContain('#1, #2');
    expect(container.textContent).toContain('80 (#2)');
  });

  it('colours every sensor of a line by its strongest one, all red-rimmed above the threshold', () => {
    render(null, 'lines', [point(1, 0.2, 0.25, 'Dachmitte', 12), point(2, 0.6, 0.25, 'Dachmitte', 368), point(3, 0.8, 0.7, null, 5)]);
    const markers = [...container.querySelectorAll('circle:not([data-testid])')];
    const [single, ...line] = markers;
    expect(line).toHaveLength(2);
    expect(new Set(line.map((marker) => marker.getAttribute('fill'))).size).toBe(1);
    expect(line.every((marker) => marker.getAttribute('stroke') === '#dc2626')).toBe(true);
    expect(single.getAttribute('stroke')).toBe('#ffffff');
  });

  it('shows the zone tooltip with its highest sensor when hovering a line', () => {
    render();
    hover(container.querySelector('[data-testid="zone-line"]')!);
    expect(container.textContent).toContain('#1, #2');
    expect(container.textContent).toContain('80 (#2)');
  });

  it('joins the points of an explicit group into a line, whatever their names', () => {
    render(null, 'lines', [
      { ...point(1, 0.2, 0.2, 'Attika'), group: 'row-0', groupLabel: null },
      { ...point(2, 0.5, 0.2, null), group: 'row-0', groupLabel: null },
      { ...point(3, 0.2, 0.6, 'RLT'), group: 'row-1', groupLabel: null },
    ]);
    expect(container.querySelectorAll('[data-testid="zone-line"]')).toHaveLength(1);
    // No group labels for rows.
    expect(container.querySelector('text')).toBeNull();
  });

  it('hides the tooltip when the cursor leaves', () => {
    render();
    const target = container.querySelectorAll('[data-testid="zone-point"]')[0]; // #3, on no line
    hover(target);
    expect(container.textContent).toContain('Sensor #3');
    act(() => {
      target.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: container }));
    });
    expect(container.textContent).not.toContain('Sensor #3');
  });
});

describe('LageplanZoneOverlay segments', () => {
  it('draws one area per zone, coloured by its highest value, red-rimmed when over the threshold', () => {
    render(null, 'segments', [...POINTS, point(4, 0.4, 0.5, 'Hauptdach', 150)]);
    const segments = container.querySelectorAll('[data-testid="zone-segment"]');
    // The unnamed sensor and the zone.
    expect(segments).toHaveLength(2);
    expect(segments[0].querySelectorAll('path')).toHaveLength(1);
    expect(segments[1].querySelectorAll('path')).toHaveLength(2);
    expect(segments[1].querySelector('path')!.getAttribute('fill')).toBe('#dc2626');
    expect(container.querySelector('[data-testid="zone-line"]')).toBeNull();
    expect(container.textContent).toContain('Hauptdach');
  });

  it('shows the zone tooltip when hovering a segment', () => {
    render(null, 'segments');
    hover(container.querySelectorAll('[data-testid="zone-segment"]')[1].querySelector('path')!);
    expect(container.textContent).toContain('#1, #2');
    expect(container.textContent).toContain('80 (#2)');
  });
});

describe('LageplanZoneOverlay points', () => {
  it('keeps every sensor on its own, labelled with its name', () => {
    render(null, 'points', [point(1, 0.2, 0.2, 'Bad Dusche'), point(2, 0.5, 0.2, 'Bad Dusche'), point(3, 0.7, 0.7, null)]);
    expect(container.querySelector('[data-testid="zone-line"]')).toBeNull();
    expect(container.querySelectorAll('[data-testid="zone-point"]')).toHaveLength(3);
    expect(Array.from(container.querySelectorAll('text')).map((text) => text.textContent)).toEqual([
      'Bad Dusche',
      'Bad Dusche',
    ]);
  });

  it('names the sensor in its tooltip', () => {
    render(null, 'points', [point(7, 0.2, 0.2, 'Bad Dusche', 42)]);
    hover(container.querySelector('[data-testid="zone-point"]')!);
    expect(container.textContent).toContain('Bad Dusche (#7)');
  });
});

describe('convexHull', () => {
  it('drops the inner points of a grid', () => {
    const grid: Array<[number, number]> = [0, 1, 2].flatMap((x) => [0, 1, 2].map((y) => [x, y] as [number, number]));
    expect(convexHull(grid)).toEqual([[0, 0], [2, 0], [2, 2], [0, 2]]);
  });

  it('returns fewer than three points as they are', () => {
    expect(convexHull([[1, 1]])).toEqual([[1, 1]]);
    expect(convexHull([[3, 1], [1, 1]])).toEqual([[1, 1], [3, 1]]);
  });
});

describe('segmentPadding', () => {
  it('is half the typical sensor spacing, within bounds', () => {
    expect(segmentPadding([[0, 0], [100, 0], [200, 0]], 1000)).toBe(50);
    expect(segmentPadding([[0, 0], [1, 0]], 1000)).toBe(20);
    expect(segmentPadding([[0, 0]], 1000)).toBe(40);
  });
});
