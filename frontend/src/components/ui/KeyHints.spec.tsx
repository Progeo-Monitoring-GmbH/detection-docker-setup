// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import KeyHints, { announceKey } from './KeyHints';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const HINTS = [
  { id: 'play', keys: ['Leertaste'], label: 'Abspielen' },
  { keys: ['Strg', 'Mausrad'], label: 'zoomen' },
];
const lit = () => [...container.querySelectorAll<HTMLElement>('[data-lit="true"]')].map((hint) => hint.textContent);

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe('KeyHints', () => {
  it('shows each key as a chip, combinations joined with +', () => {
    act(() => root.render(<KeyHints hints={HINTS} />));
    expect([...container.querySelectorAll('kbd')].map((kbd) => kbd.textContent)).toEqual(['Leertaste', 'Strg', 'Mausrad']);
    expect(container.textContent).toContain('Strg+Mausradzoomen');
  });

  it('lights the chip of a processed key for a moment', () => {
    act(() => root.render(<KeyHints hints={HINTS} />));
    act(() => announceKey('play'));
    expect(lit()).toEqual(['LeertasteAbspielen']);

    act(() => {
      vi.advanceTimersByTime(800);
    });
    expect(lit()).toEqual([]);
  });

  it('stays dark while inactive, with its note', () => {
    act(() => root.render(<KeyHints hints={HINTS} active={false} inactiveNote="Plot anklicken" />));
    act(() => announceKey('play'));
    expect(lit()).toEqual([]);
    expect(container.textContent).toContain('Plot anklicken');
  });
});
