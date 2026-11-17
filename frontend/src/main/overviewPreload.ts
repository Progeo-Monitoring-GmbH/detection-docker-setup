import { useEffect, useRef, useState } from 'react';

/**
 * Background loading of per-row data in chunks (the locations overview's
 * details and alarm summaries): every id once, CHUNK at a time, at most
 * CONCURRENCY chunks in flight - the rows on screen first. When the screen
 * changes (another page, another sort), its rows move to the front of the
 * queue, so they never wait behind the rest of the list.
 */

/** Ids per request. */
export const PRELOAD_CHUNK = 100;
/** Chunks loading at the same time. */
export const PRELOAD_CONCURRENCY = 2;

/** The queue alone - no React, so it is tested by itself. */
export class PreloadQueue {
  private waiting: number[] = [];

  /** Ids queued, loading or loaded - never asked for twice. */
  private seen = new Set<number>();

  /** Queues the ids not asked for yet; `front`: they - and those of them
   * still waiting - go before everything else. */
  add(ids: number[], front = false) {
    const waiting = new Set(this.waiting);
    const wanted = ids.filter((id) => !this.seen.has(id) || (front && waiting.has(id)));
    if (!wanted.length) {
      return;
    }
    const wantedSet = new Set(wanted);
    const rest = this.waiting.filter((id) => !wantedSet.has(id));
    this.waiting = front ? [...wanted, ...rest] : [...rest, ...wanted];
    wanted.forEach((id) => this.seen.add(id));
  }

  /** The next chunk to load (removed from the queue). */
  take(size: number) {
    return this.waiting.splice(0, size);
  }

  /** Lets ids be asked for again (their load failed and should be retried). */
  forget(ids: number[]) {
    ids.forEach((id) => this.seen.delete(id));
  }

  get size() {
    return this.waiting.length;
  }

  clear() {
    this.waiting = [];
    this.seen.clear();
  }
}

/**
 * The hook: `load(ids)` loads one chunk (resolving when done, also on an
 * error). Returns `enqueue(ids, front)` and `reset()` - the latter drops
 * everything queued; chunks still in flight of the old list are told by
 * their `generation` (the second argument of `load`) and should be ignored.
 */
export const useChunkedPreload = (
  load: (ids: number[], generation: number) => Promise<void>,
  { chunk = PRELOAD_CHUNK, concurrency = PRELOAD_CONCURRENCY } = {},
) => {
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });

  // Built once: the queue and the functions working it (stable identities).
  const [engine] = useState(() => {
    const queue = new PreloadQueue();
    let inFlight = 0;
    let generation = 0;

    function pump() {
      while (inFlight < concurrency && queue.size > 0) {
        const ids = queue.take(chunk);
        const started = generation;
        inFlight += 1;
        void loadRef.current(ids, started).finally(() => {
          if (started !== generation) {
            return;
          }
          inFlight -= 1;
          pump();
        });
      }
    }

    return {
      enqueue: (ids: number[], front = false) => {
        queue.add(ids, front);
        pump();
      },
      reset: () => {
        generation += 1;
        queue.clear();
        inFlight = 0;
        return generation;
      },
      generation: () => generation,
    };
  });
  return engine;
};

/**
 * `rows` sorted by `value` (stable) - rows whose value isn't loaded yet
 * (null) come last in either direction, so the loaded ones are on top.
 */
export const sortLoadedFirst = <T>(
  rows: T[],
  value: (row: T) => string | number | null,
  ascending: boolean,
): T[] => {
  const keyed = rows.map((row, index) => ({ row, index, key: value(row) }));
  keyed.sort((a, b) => {
    if (a.key === null || b.key === null) {
      return a.key === b.key ? a.index - b.index : a.key === null ? 1 : -1;
    }
    const order =
      typeof a.key === 'number' && typeof b.key === 'number'
        ? a.key - b.key
        : String(a.key).localeCompare(String(b.key), undefined, { numeric: true });
    return (ascending ? order : -order) || a.index - b.index;
  });
  return keyed.map(({ row }) => row);
};
