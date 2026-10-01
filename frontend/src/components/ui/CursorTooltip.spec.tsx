// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CursorTooltip, { formatClock, TooltipRow } from './CursorTooltip';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Measured tooltip size reported by the stubbed getBoundingClientRect.
const TOOLTIP_W = 200;
const TOOLTIP_H = 100;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: TOOLTIP_W,
    height: TOOLTIP_H,
  } as DOMRect);
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

type Props = Partial<Parameters<typeof CursorTooltip>[0]>;

const renderTooltip = (props: Props = {}) => {
  act(() => {
    root.render(
      <CursorTooltip
        cursorX={500}
        cursorY={400}
        containerWidth={1000}
        containerHeight={800}
        dotColor="#123456"
        title="Alarm 1"
        {...props}
      >
        {props.children ?? <TooltipRow label="Peak">150</TooltipRow>}
      </CursorTooltip>,
    );
  });
  return container.querySelector<HTMLDivElement>('.alarm-tooltip')!;
};

const px = (value: string) => Number.parseFloat(value);

describe('CursorTooltip positioning', () => {
  it('centers on the cursor and sits 50px above it when there is room', () => {
    const tooltip = renderTooltip({ cursorX: 500, cursorY: 400 });
    expect(px(tooltip.style.left)).toBe(500);
    expect(px(tooltip.style.top)).toBe(400 - TOOLTIP_H - 50);
  });

  it('clamps to the left edge (half width + 8px margin)', () => {
    const tooltip = renderTooltip({ cursorX: 10 });
    expect(px(tooltip.style.left)).toBe(TOOLTIP_W / 2 + 8);
  });

  it('clamps to the right edge', () => {
    const tooltip = renderTooltip({ cursorX: 995, containerWidth: 1000 });
    expect(px(tooltip.style.left)).toBe(1000 - TOOLTIP_W / 2 - 8);
  });

  it('prefers the left clamp when the container is narrower than the tooltip', () => {
    const tooltip = renderTooltip({ cursorX: 50, containerWidth: 150 });
    expect(px(tooltip.style.left)).toBe(TOOLTIP_W / 2 + 8);
  });

  it('flips below the cursor when there is no room above', () => {
    const tooltip = renderTooltip({ cursorY: 120 });
    expect(px(tooltip.style.top)).toBe(120 + 50);
  });

  it('clamps to the bottom edge after flipping', () => {
    const tooltip = renderTooltip({ cursorY: 100, containerHeight: 200 });
    // flipped: 150, but max top = 200 - 100 - 8 = 92
    expect(px(tooltip.style.top)).toBe(92);
  });

  it('never goes above the top margin in a tiny container', () => {
    const tooltip = renderTooltip({ cursorY: 10, containerHeight: 50 });
    expect(px(tooltip.style.top)).toBe(8);
  });

  it('applies a fixed width only when given', () => {
    expect(renderTooltip({ width: 260 }).style.width).toBe('260px');
    expect(renderTooltip({ width: undefined }).style.width).toBe('');
  });
});

describe('CursorTooltip content', () => {
  it('renders title, rows, head extra and footer', () => {
    const tooltip = renderTooltip({
      title: 'Sensor 7',
      headExtra: <span className="badge">active</span>,
      footer: <button type="button">Open</button>,
    });
    expect(tooltip.querySelector('.alarm-tooltip-title')!.textContent).toBe('Sensor 7');
    expect(tooltip.querySelector('.alarm-tooltip-head .badge')!.textContent).toBe('active');
    expect(tooltip.querySelector('.alarm-tooltip-key')!.textContent).toBe('Peak');
    expect(tooltip.querySelector('.alarm-tooltip-value')!.textContent).toBe('150');
    expect(tooltip.querySelector('button')!.textContent).toBe('Open');
  });

  it('uses the dot colour as border colour unless one is given', () => {
    const dot = renderTooltip({ dotColor: 'rgb(1, 2, 3)' }).querySelector<HTMLSpanElement>(
      '.alarm-tooltip-dot',
    )!;
    expect(dot.style.background).toBe('rgb(1, 2, 3)');
    expect(dot.style.borderColor).toBe('rgb(1, 2, 3)');

    const dot2 = renderTooltip({
      dotColor: 'rgb(1, 2, 3)',
      dotBorderColor: 'rgb(9, 9, 9)',
    }).querySelector<HTMLSpanElement>('.alarm-tooltip-dot')!;
    expect(dot2.style.borderColor).toBe('rgb(9, 9, 9)');
  });

  it('forwards mouse enter/leave handlers', () => {
    const onEnter = vi.fn();
    const onLeave = vi.fn();
    const tooltip = renderTooltip({ onMouseEnter: onEnter, onMouseLeave: onLeave });
    act(() => {
      tooltip.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }));
      tooltip.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
    });
    expect(onEnter).toHaveBeenCalledTimes(1);
    expect(onLeave).toHaveBeenCalledTimes(1);
  });
});

describe('formatClock', () => {
  it('formats ms with day, month, hour and minute', () => {
    const ms = new Date(2026, 7, 19, 11, 8).getTime();
    expect(formatClock(ms)).toBe(
      new Date(ms).toLocaleString(undefined, {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      }),
    );
  });
});
