// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FrameSlider, { alarmPosition, ANIMATION_FRAME_MS, type AlarmSpan, frameAt } from './FrameSlider';

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
});
