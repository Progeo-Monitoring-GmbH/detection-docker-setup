import { describe, expect, it } from 'vitest';
import { PreloadQueue, sortLoadedFirst } from './overviewPreload';

describe('PreloadQueue', () => {
  it('hands out every id once, in chunks', () => {
    const queue = new PreloadQueue();
    queue.add([1, 2, 3, 4, 5]);
    queue.add([3, 4, 6]);

    expect(queue.take(2)).toEqual([1, 2]);
    expect(queue.take(10)).toEqual([3, 4, 5, 6]);
    expect(queue.size).toBe(0);
  });

  it('moves the rows on screen to the front - also those already waiting', () => {
    const queue = new PreloadQueue();
    queue.add([1, 2, 3, 4, 5, 6]);
    queue.take(2); // 1 and 2 are loading

    queue.add([2, 5, 9], true);

    // 2 is loading already, 5 waited, 9 is new.
    expect(queue.take(10)).toEqual([5, 9, 3, 4, 6]);
  });

  it('asks again for ids it forgets, and starts over when cleared', () => {
    const queue = new PreloadQueue();
    queue.add([1, 2]);
    queue.take(2);

    queue.forget([2]);
    queue.add([1, 2]);
    expect(queue.take(10)).toEqual([2]);

    queue.clear();
    queue.add([1]);
    expect(queue.take(10)).toEqual([1]);
  });
});

describe('sortLoadedFirst', () => {
  const rows = [
    { id: 1, value: 3 as number | null },
    { id: 2, value: null },
    { id: 3, value: 1 },
    { id: 4, value: 3 },
    { id: 5, value: null },
  ];
  const ids = (sorted: typeof rows) => sorted.map((row) => row.id);

  it('sorts the loaded rows - stable - and puts the rest last in either direction', () => {
    expect(ids(sortLoadedFirst(rows, (row) => row.value, true))).toEqual([3, 1, 4, 2, 5]);
    expect(ids(sortLoadedFirst(rows, (row) => row.value, false))).toEqual([1, 4, 3, 2, 5]);
  });

  it('compares text naturally', () => {
    const names = [{ name: 'Halle 10' }, { name: 'halle 2' }, { name: 'Anbau' }];
    expect(sortLoadedFirst(names, (row) => row.name.toLowerCase(), true).map((row) => row.name)).toEqual([
      'Anbau',
      'halle 2',
      'Halle 10',
    ]);
  });
});
