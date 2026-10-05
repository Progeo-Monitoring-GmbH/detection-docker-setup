import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildStoredZip } from './frameZip';
import { drawFrameLabel, formatTimestamp, sleep } from './heatmapFrames';

/** Reads every entry (name -> text) of a store-only zip via its local headers. */
const readStoredZip = async (blob: Blob) => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const decoder = new TextDecoder();
  const entries = new Map<string, string>();
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = decoder.decode(
      bytes.subarray(nameStart, nameStart + nameLength),
    );
    entries.set(
      name,
      decoder.decode(bytes.subarray(dataStart, dataStart + size)),
    );
    offset = dataStart + size;
  }
  return entries;
};

afterEach(() => {
  vi.useRealTimers();
});

describe('formatTimestamp', () => {
  it('returns "n/a" for null/undefined', () => {
    expect(formatTimestamp(null)).toBe('n/a');
    expect(formatTimestamp(undefined)).toBe('n/a');
  });

  it('formats unix seconds (not ms) with a 2-digit locale format', () => {
    const seconds = 1_787_000_000;
    const expected = new Date(seconds * 1000).toLocaleString(undefined, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    expect(formatTimestamp(seconds)).toBe(expected);
  });

  it('returns the raw value for an invalid timestamp', () => {
    expect(formatTimestamp(Number.NaN)).toBe('NaN');
    expect(formatTimestamp(1e20)).toBe('100000000000000000000');
  });
});

describe('sleep', () => {
  it('resolves after the given time (fake timers)', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', globalThis);
    const done = vi.fn();
    const promise = sleep(500).then(done);
    await vi.advanceTimersByTimeAsync(499);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await promise;
    expect(done).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});

describe('drawFrameLabel', () => {
  const makeCtx = (withRoundRect: boolean) => ({
    font: '',
    fillStyle: '',
    textAlign: '',
    textBaseline: '',
    measureText: vi.fn(() => ({ width: 100 })),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    beginPath: vi.fn(),
    fill: vi.fn(),
    ...(withRoundRect ? { roundRect: vi.fn() } : {}),
  });

  it('draws a pill in the bottom-right corner with the frame counter', () => {
    const ctx = makeCtx(true);
    drawFrameLabel(
      ctx as unknown as CanvasRenderingContext2D,
      800,
      600,
      null,
      3,
      10,
    );

    // box = text 100 + 2*14 padding = 128 wide, 34 high, 16px from the edges
    expect(ctx.roundRect).toHaveBeenCalledWith(
      800 - 128 - 16,
      600 - 34 - 16,
      128,
      34,
      6,
    );
    expect(ctx.fill).toHaveBeenCalled();
    expect(ctx.fillRect).not.toHaveBeenCalled();
    const [text] = ctx.fillText.mock.calls[0];
    expect(text).toBe('n/a  ·  frame 3/10');
    expect(ctx.fillStyle).toBe('#ffffff');
  });

  it('falls back to fillRect when roundRect is unavailable', () => {
    const ctx = makeCtx(false);
    drawFrameLabel(
      ctx as unknown as CanvasRenderingContext2D,
      800,
      600,
      null,
      1,
      1,
    );
    expect(ctx.fillRect).toHaveBeenCalledWith(656, 550, 128, 34);
  });
});

describe('buildStoredZip', () => {
  it('stores the frames under their names and contents', async () => {
    const encoder = new TextEncoder();
    const entries = await readStoredZip(
      buildStoredZip([
        { name: 'frames/frame_0001.png', data: encoder.encode('first') },
        { name: 'frames/frame_0002.png', data: encoder.encode('second') },
      ]),
    );
    expect([...entries.entries()]).toEqual([
      ['frames/frame_0001.png', 'first'],
      ['frames/frame_0002.png', 'second'],
    ]);
  });

  it('works with zero entries', async () => {
    const entries = await readStoredZip(buildStoredZip([]));
    expect(entries.size).toBe(0);
  });
});
