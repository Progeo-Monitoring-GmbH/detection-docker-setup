// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  frameKeyStep,
  isRangeClearKey,
  planKeyIndex,
  steppedFrameTime,
} from './analyseKeys';

const key = (
  name: string,
  extra: Partial<Omit<KeyboardEvent, 'key'>> = {},
): KeyboardEvent =>
  ({
    key: name,
    repeat: false,
    defaultPrevented: false,
    isComposing: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    target: document.body,
    ...extra,
  }) as KeyboardEvent;

const input = (type: string) => {
  const element = document.createElement('input');
  element.type = type;
  return element;
};

describe('frameKeyStep', () => {
  it('steps one frame with ←/→ and ten with ↑/↓', () => {
    expect(frameKeyStep(key('ArrowLeft'))).toBe(-1);
    expect(frameKeyStep(key('ArrowRight'))).toBe(1);
    expect(frameKeyStep(key('ArrowUp'))).toBe(10);
    expect(frameKeyStep(key('ArrowDown'))).toBe(-10);
  });

  it('ignores other keys, modifiers and handled or composing keys', () => {
    expect(frameKeyStep(key('a'))).toBeNull();
    expect(frameKeyStep(key('ArrowLeft', { shiftKey: true }))).toBeNull();
    expect(frameKeyStep(key('ArrowLeft', { ctrlKey: true }))).toBeNull();
    expect(frameKeyStep(key('ArrowLeft', { altKey: true }))).toBeNull();
    expect(frameKeyStep(key('ArrowLeft', { metaKey: true }))).toBeNull();
    expect(
      frameKeyStep(key('ArrowLeft', { defaultPrevented: true })),
    ).toBeNull();
    expect(frameKeyStep(key('ArrowLeft', { isComposing: true }))).toBeNull();
  });

  it('leaves form controls their keys - except the range slider', () => {
    expect(
      frameKeyStep(key('ArrowLeft', { target: input('text') })),
    ).toBeNull();
    expect(
      frameKeyStep(
        key('ArrowLeft', { target: document.createElement('select') }),
      ),
    ).toBeNull();
    expect(
      frameKeyStep(
        key('ArrowLeft', { target: document.createElement('textarea') }),
      ),
    ).toBeNull();
    const editable = document.createElement('div');
    editable.contentEditable = 'true';
    // jsdom does not compute isContentEditable from the attribute.
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    expect(frameKeyStep(key('ArrowLeft', { target: editable }))).toBeNull();
    expect(frameKeyStep(key('ArrowLeft', { target: input('range') }))).toBe(-1);
    expect(frameKeyStep(key('ArrowLeft', { target: null }))).toBe(-1);
  });
});

describe('steppedFrameTime', () => {
  const frames = [10, 20, 30, 40];

  it('steps from the shown frame, the newest without one', () => {
    expect(steppedFrameTime(frames, null, -1)).toBe(30_000);
    expect(steppedFrameTime(frames, 20_000, 1)).toBe(30_000);
  });

  it('stays within the frames', () => {
    expect(steppedFrameTime(frames, 20_000, -10)).toBe(10_000);
    expect(steppedFrameTime(frames, 30_000, 10)).toBe(40_000);
  });

  it('is null when the frame does not change', () => {
    expect(steppedFrameTime(frames, null, 1)).toBeNull();
    expect(steppedFrameTime(frames, 10_000, -1)).toBeNull();
  });
});

describe('planKeyIndex', () => {
  it('maps 1-9 to the plan index while that plan exists', () => {
    expect(planKeyIndex(key('1'), 3)).toBe(0);
    expect(planKeyIndex(key('3'), 3)).toBe(2);
    expect(planKeyIndex(key('4'), 3)).toBeNull();
    expect(planKeyIndex(key('0'), 3)).toBeNull();
    expect(planKeyIndex(key('x'), 3)).toBeNull();
  });

  it('ignores held keys, modifiers and form controls (Shift is fine)', () => {
    expect(planKeyIndex(key('1', { repeat: true }), 3)).toBeNull();
    expect(planKeyIndex(key('1', { ctrlKey: true }), 3)).toBeNull();
    expect(planKeyIndex(key('1', { target: input('number') }), 3)).toBeNull();
    expect(planKeyIndex(key('1', { shiftKey: true }), 3)).toBe(0);
  });
});

describe('isRangeClearKey', () => {
  it('is C in either case, not held, not Ctrl+C', () => {
    expect(isRangeClearKey(key('c'))).toBe(true);
    expect(isRangeClearKey(key('C'))).toBe(true);
    expect(isRangeClearKey(key('c', { repeat: true }))).toBe(false);
    expect(isRangeClearKey(key('c', { ctrlKey: true }))).toBe(false);
    expect(isRangeClearKey(key('x'))).toBe(false);
    expect(isRangeClearKey(key('c', { target: input('text') }))).toBe(false);
  });
});
