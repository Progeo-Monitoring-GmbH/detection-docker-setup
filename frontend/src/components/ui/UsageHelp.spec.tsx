// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { announceKey } from './KeyHints';
import UsageHelp from './UsageHelp';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const HINTS = [
  { id: 'range-clear', keys: ['C'], label: 'Zeitraum aufheben' },
  { keys: ['Strg', 'Mausrad'], label: 'zoomen' },
];
const popover = () => document.querySelector('#test-usage');
const feedback = () => container.querySelector('[data-testid="usage-help-feedback"]')!.textContent;

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<UsageHelp id="test-usage" hints={HINTS} tips={['C hebt den Zeitraum auf']} />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe('UsageHelp', () => {
  it('shows nothing but its button until it is hovered', () => {
    expect(popover()).toBeNull();
    expect(container.textContent).toBe('usage_help');
  });

  it('shows the tips for now and every key on hover', () => {
    const button = container.querySelector('button')!;
    act(() => {
      button.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }));
      vi.advanceTimersByTime(200);
    });
    expect(popover()!.textContent).toContain('usage_help_now');
    expect(popover()!.textContent).toContain('C hebt den Zeitraum auf');
    expect(popover()!.textContent).toContain('Zeitraum aufheben');
  });

  it('tells what a processed key did - for a moment', () => {
    act(() => announceKey('range-clear'));
    expect(feedback()).toBe('C · Zeitraum aufheben');
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(feedback()).toBe('');
  });
});
