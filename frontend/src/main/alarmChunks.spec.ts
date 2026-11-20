import { describe, expect, it } from 'vitest';
import { loadAlarmChunks, mergeAlarmRows, type AlarmChunk } from './alarmChunks';

type Row = { id: number; location: { id: number } };

const chunkOf = (index: number, chunks: number): AlarmChunk<Row> => ({
  alarms: [{ id: 1, location: { id: 100 + index } }],
  rainEvents: [],
  chunks,
});

describe('loadAlarmChunks', () => {
  it('loads chunk 0 first, then the rest at most `concurrency` at a time', async () => {
    const asked: number[] = [];
    let inFlight = 0;
    let peak = 0;
    const handed: number[] = [];
    const progress: string[] = [];

    const result = await loadAlarmChunks<Row>({
      fetchChunk: async (index) => {
        asked.push(index);
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        return chunkOf(index, 6);
      },
      onChunk: (chunk) => handed.push(chunk.alarms[0].location.id - 100),
      onProgress: (done, total) => progress.push(`${done}/${total}`),
      concurrency: 2,
    });

    expect(result).toEqual({ complete: true });
    expect(asked[0]).toBe(0);
    expect([...asked].sort()).toEqual([0, 1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
    expect([...handed].sort()).toEqual([0, 1, 2, 3, 4, 5]);
    expect(progress[progress.length - 1]).toBe('6/6');
  });

  it('keeps loading after a failed chunk but reports the window incomplete', async () => {
    const handed: number[] = [];
    const result = await loadAlarmChunks<Row>({
      fetchChunk: async (index) => (index === 1 ? null : chunkOf(index, 3)),
      onChunk: (chunk) => handed.push(chunk.alarms[0].location.id - 100),
    });

    expect(result).toEqual({ complete: false });
    expect(handed.sort()).toEqual([0, 2]);
  });

  it('stops when the first chunk fails', async () => {
    const asked: number[] = [];
    const result = await loadAlarmChunks<Row>({
      fetchChunk: async (index) => {
        asked.push(index);
        return null;
      },
      onChunk: () => undefined,
    });

    expect(result).toEqual({ complete: false });
    expect(asked).toEqual([0]);
  });

  it('hands nothing on once a newer load started', async () => {
    let current = true;
    const handed: number[] = [];
    const result = await loadAlarmChunks<Row>({
      fetchChunk: async (index) => {
        if (index === 1) {
          current = false; // a refresh started while chunk 1 loaded
        }
        return chunkOf(index, 4);
      },
      onChunk: (chunk) => handed.push(chunk.alarms[0].location.id - 100),
      cancelled: () => !current,
      concurrency: 1,
    });

    expect(result).toEqual({ complete: false });
    expect(handed).toEqual([0]);
  });
});

describe('mergeAlarmRows', () => {
  it('keeps alarms of different project databases that share an id', () => {
    const merged = mergeAlarmRows<Row>(
      [{ id: 1, location: { id: 10 } }],
      [{ id: 1, location: { id: 20 } }, { id: 1, location: { id: 10 } }],
    );
    expect(merged.map((row) => `${row.location.id}:${row.id}`)).toEqual(['10:1', '20:1']);
  });
});
