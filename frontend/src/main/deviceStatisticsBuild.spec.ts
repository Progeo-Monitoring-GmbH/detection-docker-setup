import { describe, expect, it } from 'vitest';
import { addCounts, mergeTypeCounts, runChunks } from './deviceStatisticsBuild';

describe('addCounts', () => {
  it('adds per key, keys of either side', () => {
    expect(addCounts({ devices: 2, dead: 1 }, { devices: 3, locations: 4 } as never)).toEqual({
      devices: 5,
      dead: 1,
      locations: 4,
    });
  });
});

describe('mergeTypeCounts', () => {
  it('sums the same type and orders by count, then type', () => {
    const merged = mergeTypeCounts(
      [
        { type: '1', label: 'smartex® dm', count: 2 },
        { type: '3', label: 'smartex® is', count: 1 },
      ],
      [
        { type: '3', label: 'smartex® is', count: 4 },
        { type: '6', label: 'LoRaWan', count: 2 },
      ],
    );
    expect(merged).toEqual([
      { type: '3', label: 'smartex® is', count: 5 },
      { type: '1', label: 'smartex® dm', count: 2 },
      { type: '6', label: 'LoRaWan', count: 2 },
    ]);
  });

  it('leaves its inputs alone', () => {
    const a = [{ type: '1', label: 'dm', count: 1 }];
    mergeTypeCounts(a, [{ type: '1', label: 'dm', count: 1 }]);
    expect(a[0].count).toBe(1);
  });
});

describe('runChunks', () => {
  it('runs every chunk once with at most `concurrency` at a time', async () => {
    let running = 0;
    let peak = 0;
    const done: number[] = [];
    await runChunks(5, 2, async (index) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 1));
      done.push(index);
      running -= 1;
    });
    expect(done.sort()).toEqual([0, 1, 2, 3, 4]);
    expect(peak).toBe(2);
  });

  it('stops starting chunks after a failure and throws it', async () => {
    const started: number[] = [];
    await expect(
      runChunks(10, 1, async (index) => {
        started.push(index);
        if (index === 1) {
          throw new Error('boom');
        }
      }),
    ).rejects.toThrow('boom');
    expect(started).toEqual([0, 1]);
  });

  it('stops when cancelled', async () => {
    const started: number[] = [];
    await runChunks(10, 1, async (index) => {
      started.push(index);
    }, () => started.length >= 3);
    expect(started).toEqual([0, 1, 2]);
  });

  it('does nothing without chunks', async () => {
    await runChunks(0, 2, async () => {
      throw new Error('never');
    });
  });
});
