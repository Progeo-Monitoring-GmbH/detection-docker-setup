// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import ScrollShadow from './ScrollShadow';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no layout: the scroller's widths are set by hand.
let contentWidth = 300;
let boxWidth = 300;
Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
  configurable: true,
  get() {
    return contentWidth;
  },
});
Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
  configurable: true,
  get() {
    return boxWidth;
  },
});

describe('ScrollShadow', () => {
  let container: HTMLDivElement;
  let root: Root;

  const render = () =>
    act(() =>
      root.render(
        <ScrollShadow testId="shadow">
          <table />
        </ScrollShadow>,
      ),
    );
  const box = () => container.querySelector('[data-testid="shadow"]') as HTMLDivElement;
  const scroller = () => box().querySelector('.progeo-scroll-shadow-scroller') as HTMLDivElement;
  const scrollTo = (left: number) =>
    act(() => {
      scroller().scrollLeft = left;
      scroller().dispatchEvent(new Event('scroll', { bubbles: true }));
    });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('shows no cue when the content fits', () => {
    contentWidth = 300;
    boxWidth = 300;
    render();
    expect(box().className).toBe('progeo-scroll-shadow');
  });

  it('marks the side that has more content while scrolling', () => {
    contentWidth = 700;
    boxWidth = 300;
    render();
    expect(box().classList.contains('progeo-scroll-shadow--end')).toBe(true);
    expect(box().classList.contains('progeo-scroll-shadow--start')).toBe(false);

    scrollTo(200);
    expect(box().classList.contains('progeo-scroll-shadow--start')).toBe(true);
    expect(box().classList.contains('progeo-scroll-shadow--end')).toBe(true);

    scrollTo(400);
    expect(box().classList.contains('progeo-scroll-shadow--start')).toBe(true);
    expect(box().classList.contains('progeo-scroll-shadow--end')).toBe(false);
  });
});
