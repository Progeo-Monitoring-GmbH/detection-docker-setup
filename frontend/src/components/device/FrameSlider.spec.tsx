// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FrameSlider, {
  alarmPosition,
  ANIMATION_FRAME_MS,
  type AlarmSpan,
  draggedSelection,
  frameAt,
} from './FrameSlider';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TIMESTAMPS = [0, 3600, 7200, 10800, 14400].map((seconds) => 1_790_000_000 + seconds);

let container: HTMLDivElement;
let root: Root;
let shown: number[];

const Harness = ({ start, alarms }: { start: number; alarms?: AlarmSpan[] }) => {
  const [index, setIndex] = useState(start);
  shown.push(index);
  return <FrameSlider id="frames" timestamps={TIMESTAMPS} index={index} onChange={setIndex} alarms={alarms} />;
};

const render = (start = 0, alarms?: AlarmSpan[]) => {
  act(() => root.render(<Harness start={start} alarms={alarms} />));
};

const current = () => Number(container.querySelector<HTMLInputElement>('#frames')!.value);
const button = () => container.querySelector('button')!;
const tick = (frames = 1) => act(() => vi.advanceTimersByTime(frames * ANIMATION_FRAME_MS));
const space = (target: EventTarget = document.body) =>
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true }));
  });

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  shown = [];
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('FrameSlider animation', () => {
  it('steps through the frames and stops at the last one', () => {
    render(1);
    act(() => button().click());
    expect(button().getAttribute('aria-pressed')).toBe('true');
    tick();
    expect(current()).toBe(2);
    tick(5);
    expect(current()).toBe(4);
    expect(button().getAttribute('aria-pressed')).toBe('false');
  });

  it('starts from the first frame when it is at the end', () => {
    render(4);
    act(() => button().click());
    expect(current()).toBe(0);
    tick(2);
    expect(current()).toBe(2);
  });

  it('stops where it is when pressed again', () => {
    render(0);
    act(() => button().click());
    tick(2);
    act(() => button().click());
    tick(3);
    expect(current()).toBe(2);
  });

  it('starts and stops with the space bar', () => {
    render(0);
    space();
    tick();
    expect(current()).toBe(1);
    space();
    tick(3);
    expect(current()).toBe(1);
  });

  it('leaves the space bar to text fields', () => {
    render(0);
    const field = document.createElement('input');
    document.body.appendChild(field);
    space(field);
    tick(2);
    expect(current()).toBe(0);
    field.remove();
  });
});

const at = (frame: number) => TIMESTAMPS[0] * 1000 + frame * 3600 * 1000;
const alarm = (from: number, to: number): AlarmSpan => ({ key: `a${from}`, from: at(from), to: at(to), label: 'Alarm' });

describe('FrameSlider alarms', () => {
  it('places an alarm over its frames, cut to the slider', () => {
    expect(alarmPosition(TIMESTAMPS, alarm(1, 3))).toEqual({ left: 0.25, right: 0.75 });
    expect(alarmPosition(TIMESTAMPS, alarm(-5, 2))).toEqual({ left: 0, right: 0.5 });
    expect(alarmPosition(TIMESTAMPS, alarm(3, 99))).toEqual({ left: 0.75, right: 1 });
    expect(alarmPosition(TIMESTAMPS, alarm(10, 12))).toBeNull();
  });

  it('finds the frame an alarm starts in', () => {
    expect(frameAt(TIMESTAMPS, at(1.5))).toBe(1); // the 1 h frame from 1:00 holds 1:30
    expect(frameAt(TIMESTAMPS, at(2))).toBe(2);
    expect(frameAt(TIMESTAMPS, at(-1))).toBe(0);
    expect(frameAt(TIMESTAMPS, at(9))).toBe(4);
  });

  it('takes the next frame after a gap without data', () => {
    const gappy = [0, 1, 2, 10, 11].map((hour) => TIMESTAMPS[0] + hour * 3600);
    expect(frameAt(gappy, at(5))).toBe(3); // 5:00 lies in the gap: on to 10:00
    expect(frameAt(gappy, at(2.5))).toBe(2);
  });

  it('marks the alarms and jumps to one on click', () => {
    render(0, [alarm(2, 3), alarm(10, 11)]);
    expect(container.querySelectorAll('.frame-slider__alarm')).toHaveLength(1);
    act(() => container.querySelector<HTMLButtonElement>('.frame-slider__alarm-jump')!.click());
    expect(current()).toBe(2);
  });

  it('draws the alarms behind the track and the time labels - no strip over them', () => {
    render(0, [alarm(2, 3)]);
    const layer = container.querySelector('.frame-slider__alarm-layer')!;
    const input = container.querySelector('input[type="range"]')!;
    const labels = container.querySelector('.time-axis')!;
    // Earlier in the body: painted first, the other layers lie over it.
    expect(layer.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(layer.compareDocumentPosition(labels) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(input.closest('.frame-slider__layer')).not.toBeNull();
    expect(labels.closest('.frame-slider__layer')).not.toBeNull();
    expect(container.querySelector('.frame-slider__alarm-strip')).toBeNull();
  });

  it('tells the hovered alarm in a tooltip', () => {
    render(0, [alarm(2, 3)]);
    const body = container.querySelector('.frame-slider__body')!;
    const tooltip = () => container.querySelector('[data-testid="frame-slider-alarm-tooltip"]');
    // jsdom has no layout: the alarm layer counts as 400 px from x 0 - the
    // alarm covers 50 %..75 % (200..300 px).
    const hover = (x: number) =>
      act(() => {
        vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 400 } as DOMRect);
        body.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: x }));
      });

    hover(100);
    expect(tooltip()).toBeNull();
    hover(250);
    expect(tooltip()!.textContent).toContain('Alarm');
    expect(container.querySelector('.frame-slider__alarm--hovered')).not.toBeNull();
    act(() => {
      body.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: document.body }));
    });
    expect(tooltip()).toBeNull();
    vi.restoreAllMocks();
  });

  it('tells a focused alarm too (keyboard)', () => {
    render(0, [alarm(2, 3)]);
    act(() => container.querySelector<HTMLButtonElement>('.frame-slider__alarm-jump')!.focus());
    expect(container.querySelector('[data-testid="frame-slider-alarm-tooltip"]')!.textContent).toContain('Alarm');
  });
});

describe('FrameSlider visible range', () => {
  const renderRange = (visibleRange: { from: number; to: number } | null) =>
    act(() =>
      root.render(
        <FrameSlider id="frames" timestamps={TIMESTAMPS} index={0} onChange={() => {}} visibleRange={visibleRange} />,
      ),
    );
  const band = () => container.querySelector<HTMLElement>('.frame-slider__visible');

  it('marks the shown span on the track, cut to the frames', () => {
    renderRange({ from: at(1), to: at(3) });
    expect(band()!.style.left).toBe('25%');
    expect(band()!.style.width).toBe('50%');

    renderRange({ from: at(-2), to: at(99) });
    expect(band()!.style.left).toBe('0%');
    expect(band()!.style.width).toBe('100%');
  });

  it('has no band without a span or outside of the frames', () => {
    renderRange(null);
    expect(band()).toBeNull();
    renderRange({ from: at(10), to: at(12) });
    expect(band()).toBeNull();
  });
});

describe('FrameSlider selection', () => {
  // jsdom has no layout: the strip counts as 400 px wide from x 0 - over the
  // 5 frames one frame is 100 px (25 %).
  const strip = () => container.querySelector<HTMLElement>('[data-testid="frame-slider-selection-strip"]')!;
  const band = () => container.querySelector<HTMLElement>('[data-testid="frame-slider-selection"]');
  const fire = (target: Element, type: string, x: number) =>
    act(() => {
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 400 } as DOMRect);
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x }));
    });
  const drag = (target: Element, from: number, to: number) => {
    fire(target, 'pointerdown', from);
    fire(strip(), 'pointermove', to);
    fire(strip(), 'pointerup', to);
  };
  let picked: { from: number; to: number }[];
  const renderSelection = (selection: { from: number; to: number } | null) =>
    act(() =>
      root.render(
        <FrameSlider
          id="frames"
          timestamps={TIMESTAMPS}
          index={0}
          onChange={() => {}}
          selection={selection}
          onSelectionChange={(next) => picked.push(next)}
        />,
      ),
    );

  beforeEach(() => {
    picked = [];
  });

  it('moves a band whole and keeps it inside, resizes one edge down to a frame', () => {
    expect(draggedSelection({ mode: 'move', left: 0.25, right: 0.5 }, 0.25, 0.25)).toEqual({ left: 0.5, right: 0.75 });
    expect(draggedSelection({ mode: 'move', left: 0.25, right: 0.5 }, 0.9, 0.25)).toEqual({ left: 0.75, right: 1 });
    expect(draggedSelection({ mode: 'start', left: 0.25, right: 0.5 }, 0.5, 0.25)).toEqual({ left: 0.25, right: 0.5 });
    expect(draggedSelection({ mode: 'end', left: 0.25, right: 0.5 }, 0.25, 0.25)).toEqual({ left: 0.25, right: 0.75 });
    expect(draggedSelection({ mode: 'create', left: 0.5, right: 0.5 }, -0.25, 0.25)).toEqual({ left: 0.25, right: 0.5 });
  });

  it('shows the selection as a band below the track', () => {
    renderSelection({ from: at(1), to: at(2) });
    expect(band()!.style.left).toBe('25%');
    expect(band()!.style.width).toBe('25%');
    expect(container.querySelector('.frame-slider__selection-shade')).not.toBeNull();
  });

  it('drags the band to another time, keeping its length', () => {
    renderSelection({ from: at(1), to: at(2) });
    drag(band()!, 150, 250);
    expect(picked).toEqual([{ from: at(2), to: at(3) }]);
  });

  it('changes the length at a grip', () => {
    renderSelection({ from: at(1), to: at(2) });
    drag(container.querySelector('[data-testid="frame-slider-selection-end"]')!, 200, 400);
    expect(picked).toEqual([{ from: at(1), to: at(4) }]);
  });

  it('draws a new selection on the empty strip - a click alone draws none', () => {
    renderSelection(null);
    expect(band()).toBeNull();
    drag(strip(), 300, 100);
    expect(picked).toEqual([{ from: at(1), to: at(3) }]);
    drag(strip(), 200, 200);
    expect(picked).toHaveLength(1);
  });

  it('moves the focused band a frame with the arrow keys', () => {
    renderSelection({ from: at(1), to: at(2) });
    act(() => {
      band()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    });
    expect(picked).toEqual([{ from: at(2), to: at(3) }]);
  });

  it('has no strip without onSelectionChange', () => {
    act(() => root.render(<FrameSlider id="frames" timestamps={TIMESTAMPS} index={0} onChange={() => {}} />));
    expect(container.querySelector('[data-testid="frame-slider-selection-strip"]')).toBeNull();
  });
});
