// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SegmentedControl from './SegmentedControl';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// The phone switch: useIsMobile asks matchMedia (jsdom has none).
let phone = false;
window.matchMedia = (query: string) =>
  ({
    matches: query.includes('max-width') ? phone : false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }) as MediaQueryList;

// jsdom has no layout: every pill 100px wide, the room around the control `room`.
let room = 400;
const PILL = 100;

const options = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta' },
  { value: 'c', label: 'Gamma' },
];

describe('SegmentedControl', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return { width: this.tagName === 'BUTTON' ? PILL : 0 } as DOMRect;
    });
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => room);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    phone = false;
    room = 400;
  });

  const render = (onChange = vi.fn()) => {
    act(() => {
      root.render(<SegmentedControl options={options} value="b" onChange={onChange} testId="seg" />);
    });
    return onChange;
  };
  const pills = () => container.querySelectorAll('[data-testid="seg-option"]');
  const select = () => container.querySelector<HTMLSelectElement>('[data-testid="seg-select"]');

  it('shows the pills on a wide screen, even without room', () => {
    room = 150;
    render();
    expect(pills()).toHaveLength(3);
    expect(select()).toBeNull();
  });

  it('keeps the pills on a phone while they fit in one row', () => {
    phone = true;
    render();
    expect(pills()).toHaveLength(3);
    expect(select()).toBeNull();
  });

  it('is a dropdown on a phone where the pills would wrap', () => {
    phone = true;
    room = 250;
    const onChange = render();
    expect(pills()).toHaveLength(0);
    expect(container.querySelector('[data-testid="seg"]')).not.toBeNull();
    const dropdown = select()!;
    expect(dropdown.value).toBe('b');
    expect(Array.from(dropdown.options).map((option) => option.textContent)).toEqual(['Alpha', 'Beta', 'Gamma']);
    act(() => {
      dropdown.value = 'c';
      dropdown.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith('c');
  });
});
