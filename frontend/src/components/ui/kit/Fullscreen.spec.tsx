// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FullscreenButton, FullscreenFrame, useFullscreen } from './Fullscreen';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no fullscreen API - like iPhone Safari, so the covering fallback.
const Panel = () => {
  const fullscreen = useFullscreen();
  return (
    <FullscreenFrame state={fullscreen}>
      <FullscreenButton state={fullscreen} testId="fullscreen" />
      <div>Lageplan</div>
    </FullscreenFrame>
  );
};

describe('Fullscreen', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<Panel />));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const frame = () =>
    container.querySelector('.progeo-fullscreen') as HTMLDivElement;
  const button = () =>
    container.querySelector('[data-testid="fullscreen"]') as HTMLButtonElement;

  it('covers the page without the browser fullscreen, and leaves on the button', () => {
    expect(frame().className).toBe('progeo-fullscreen');
    expect(button().getAttribute('aria-pressed')).toBe('false');

    act(() => button().click());
    expect(frame().classList.contains('progeo-fullscreen--fallback')).toBe(
      true,
    );
    expect(frame().classList.contains('progeo-fullscreen--active')).toBe(true);
    expect(button().getAttribute('aria-pressed')).toBe('true');
    expect(document.body.style.overflow).toBe('hidden');

    act(() => button().click());
    expect(frame().className).toBe('progeo-fullscreen');
    expect(document.body.style.overflow).toBe('');
  });

  it('leaves the covering fallback on Escape', () => {
    act(() => button().click());
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(frame().classList.contains('progeo-fullscreen--fallback')).toBe(
      false,
    );
  });
});
