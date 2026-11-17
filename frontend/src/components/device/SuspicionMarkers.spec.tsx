// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import SuspicionMarkersOverlay, {
  markerSize,
  placeSuspicionMarkers,
  type SuspicionPlanMarker,
} from './SuspicionMarkers';

const marker = (
  id: string,
  x: number,
  y: number,
  extra: Partial<SuspicionPlanMarker> = {},
): SuspicionPlanMarker => ({
  id,
  x,
  y,
  lageplan: 1,
  label: id.toUpperCase(),
  state: 'neu',
  strength: 1,
  ...extra,
});

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const world = { width: 1000, height: 500 };

describe('placeSuspicionMarkers', () => {
  it('places normalized points like the sensors (y down, no alignment)', () => {
    const [placed] = placeSuspicionMarkers(
      [marker('a', 0.25, 0.2)],
      null,
      null,
      false,
      world,
    );

    // y = 1 - ny in plot space, plotToWorld mirrors it back: 0.2 of the height from the top.
    expect(placed.wx).toBeCloseTo(250);
    expect(placed.wy).toBeCloseTo(100);
  });

  it('follows a vertically flipped plan', () => {
    const [placed] = placeSuspicionMarkers(
      [marker('a', 0.25, 0.2)],
      null,
      null,
      true,
      world,
    );

    expect(placed.wy).toBeCloseTo(400);
  });

  it('applies the plan alignment (scale)', () => {
    const location = { scale_x: 0.5, scale_y: 1 } as Parameters<
      typeof placeSuspicionMarkers
    >[1];
    const [placed] = placeSuspicionMarkers(
      [marker('a', 0.5, 0.5)],
      location,
      null,
      false,
      world,
    );

    expect(placed.wx).toBeCloseTo(250);
  });

  it('skips invalid points and handles none', () => {
    expect(
      placeSuspicionMarkers(
        [marker('a', Number.NaN, 0)],
        null,
        null,
        false,
        world,
      ),
    ).toEqual([]);
    expect(placeSuspicionMarkers(undefined, null, null, false, world)).toEqual(
      [],
    );
  });
});

describe('markerSize', () => {
  it('grows with the strength, clamped', () => {
    expect(markerSize(0)).toBe(22);
    expect(markerSize(1)).toBe(40);
    expect(markerSize(5)).toBe(40);
  });
});

describe('SuspicionMarkersOverlay', () => {
  it('draws the visible markers at their screen position, lettered and coloured by state', () => {
    const placed = placeSuspicionMarkers(
      [
        marker('a', 0.1, 0.1),
        marker('b', 0.5, 0.5, { state: 'geloest' }),
        marker('far', 5, 5),
      ],
      null,
      null,
      false,
      world,
    );

    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => {
      root.render(
        <SuspicionMarkersOverlay
          markers={placed}
          view={{ scale: 0.5, tx: 10, ty: 0 }}
          width={600}
          height={300}
        />,
      );
    });

    const shown = [
      ...container.querySelectorAll<HTMLElement>(
        '[data-testid="suspicion-marker"]',
      ),
    ];
    expect(
      shown.map((element) => element.getAttribute('data-test-key')),
    ).toEqual(['a', 'b']);
    expect(shown[0].style.left).toBe('60px');
    expect(shown[0].style.top).toBe('25px');
    expect(shown[1].className).toContain('suspicion-marker--geloest');
    expect(shown[1].textContent).toBe('B');
    act(() => root.unmount());
  });
});
