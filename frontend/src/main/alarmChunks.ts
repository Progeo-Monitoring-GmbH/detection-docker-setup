/**
 * The alarms overview (/alarms/) loads its window in chunks of project
 * databases (GET /v1/alarm/?chunk=k, backend AlarmViewSet.list): chunk 0
 * says how many there are, the rest follow a few at a time - the page shows
 * each chunk as it arrives instead of waiting for every database.
 */
import { alarmKey, rainEventKey, type RainEvent } from './alarmUtils';

/** Chunks loading at the same time after the first. */
export const ALARM_CHUNK_CONCURRENCY = 3;

export type AlarmChunk<Row> = { alarms: Row[]; rainEvents: RainEvent[]; chunks: number };

/**
 * Loads chunk 0, then chunks 1..n-1 (`concurrency` at a time), handing each
 * to `onChunk` as it arrives. `fetchChunk` resolves null on an error. Resolves
 * { complete } - false when any chunk failed (the rest still load) or
 * `cancelled()` turned true (a newer load started: nothing more is handed on).
 */
export const loadAlarmChunks = async <Row>({
  fetchChunk,
  onChunk,
  onProgress,
  cancelled = () => false,
  concurrency = ALARM_CHUNK_CONCURRENCY,
}: {
  fetchChunk: (index: number) => Promise<AlarmChunk<Row> | null>;
  onChunk: (chunk: AlarmChunk<Row>) => void;
  onProgress?: (done: number, total: number) => void;
  cancelled?: () => boolean;
  concurrency?: number;
}): Promise<{ complete: boolean }> => {
  const first = await fetchChunk(0);
  if (cancelled()) {
    return { complete: false };
  }
  if (!first) {
    return { complete: false };
  }
  onChunk(first);
  const total = Math.max(1, first.chunks);
  let done = 1;
  let failed = false;
  onProgress?.(done, total);

  let next = 1;
  const worker = async () => {
    while (next < total && !cancelled()) {
      const index = next;
      next += 1;
      const chunk = await fetchChunk(index);
      if (cancelled()) {
        return;
      }
      if (chunk) {
        onChunk(chunk);
      } else {
        failed = true;
      }
      done += 1;
      onProgress?.(done, total);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, total - 1) }, worker));
  return { complete: !failed && !cancelled() };
};

/** `incoming` over `current`, by alarmKey (ids repeat across project databases) - incoming wins. */
export const mergeAlarmRows = <Row extends Parameters<typeof alarmKey>[0]>(current: Row[], incoming: Row[]) => {
  const byKey = new Map(current.map((row) => [alarmKey(row), row]));
  incoming.forEach((row) => byKey.set(alarmKey(row), row));
  return [...byKey.values()];
};

/** Rain events of both, once each (an event can span two loaded windows or chunks). */
export const mergeRainEvents = (current: RainEvent[], incoming: RainEvent[]) => {
  const byKey = new Map(current.map((event) => [rainEventKey(event), event]));
  incoming.forEach((event) => byKey.set(rainEventKey(event), event));
  return [...byKey.values()];
};
