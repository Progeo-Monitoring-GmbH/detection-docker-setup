// @vitest-environment jsdom
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axiosConfig from '../../axiosConfig';
import useCadImportJob, { type CadImportJob } from './useCadImportJob';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const JOB_ID = 'a'.repeat(32);

class FakeSocket {
  static last: FakeSocket;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;

  constructor(public url: string) {
    FakeSocket.last = this;
  }

  close() {
    this.closed = true;
  }

  receive(payload: object) {
    act(() => this.onmessage?.({ data: JSON.stringify(payload) }));
  }
}

const job = (fields: Partial<CadImportJob>): CadImportJob => ({
  job_id: JOB_ID,
  status: 'running',
  log: [],
  result: null,
  error: null,
  ...fields,
});

let container: HTMLDivElement;
let root: Root;
const hook = {} as { state: ReturnType<typeof useCadImportJob> };
let finished: CadImportJob[];

const Harness = () => {
  const state = useCadImportJob({} as never, (done) => finished.push(done));
  useEffect(() => {
    hook.state = state;
  });
  return null;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', FakeSocket);
  container = document.createElement('div');
  root = createRoot(container);
  finished = [];
  act(() => root.render(<Harness />));
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('useCadImportJob', () => {
  it('shows the snapshot, then appends new lines once', () => {
    act(() => hook.state.follow(JOB_ID));
    const socket = FakeSocket.last;
    expect(socket.url).toMatch(new RegExp(`/ws/cad_import/${JOB_ID}/$`));

    socket.receive({ type: 'cad_snapshot', job: job({ log: ['one'] }) });
    socket.receive({ type: 'cad_log', seq: 0, line: 'one' }); // already in the snapshot
    socket.receive({ type: 'cad_log', seq: 1, line: 'two' });

    expect(hook.state.job?.log).toEqual(['one', 'two']);
    expect(hook.state.running).toBe(true);
    expect(finished).toEqual([]);
  });

  it('hands over the result once the job is done', () => {
    act(() => hook.state.follow(JOB_ID));
    const done = job({ status: 'done', log: ['one'], result: { stored: 2, points: [] } });

    FakeSocket.last.receive({ type: 'cad_done', job: done });

    expect(finished).toEqual([done]);
    expect(hook.state.running).toBe(false);
    expect(FakeSocket.last.closed).toBe(true);
  });

  it('polls over HTTP while the socket is down', () => {
    const failed = job({ status: 'failed', error: 'out of memory' });
    const get = vi.spyOn(axiosConfig, 'perform_get').mockImplementation(async (_auth, url, onSuccess) => {
      expect(url).toBe(`/v1/status/measure_points/cad_job/?job_id=${JOB_ID}`);
      onSuccess({ data: { job: failed } });
    });
    act(() => hook.state.follow(JOB_ID));

    act(() => FakeSocket.last.onclose?.());

    expect(get).toHaveBeenCalledTimes(1);
    expect(finished).toEqual([failed]);
    act(() => vi.advanceTimersByTime(10_000));
    expect(get).toHaveBeenCalledTimes(1);
  });
});
