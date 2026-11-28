// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The status socket - its messages are sent by the tests. */
class FakeSocket {
  static instances: FakeSocket[] = [];
  url: string;
  closed = false;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
    this.onclose?.({ code: 1000 });
  }

  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}
(globalThis as { WebSocket?: unknown }).WebSocket = FakeSocket;

/** GET .../latest-measurement/: answers with `api.latest` (or fails with `api.status`). */
const api = vi.hoisted(() => ({
  latest: null as number | null,
  /** Per kind (?kind=...), when set - else `latest`. */
  latestOf: {} as Record<string, number | null>,
  status: 200,
  calls: 0,
  urls: [] as string[],
}));
vi.mock('../axiosConfig', () => ({
  default: {
    perform_get: (
      _auth: unknown,
      url: string,
      ok: (response: unknown) => void,
      fail: (error: unknown) => void,
    ) => {
      api.calls += 1;
      api.urls.push(url);
      const kind = /[?&]kind=(\w+)/.exec(url)?.[1];
      if (api.status === 200) {
        ok({ data: { id: kind && kind in api.latestOf ? api.latestOf[kind] : api.latest } });
      } else {
        fail({ response: { status: api.status } });
      }
      return Promise.resolve();
    },
  },
}));
vi.mock('../../hooks/CoreAuthProvider.tsx', () => ({ useAuth: () => ({}) }));

const {
  useLocationLiveRevision,
  parseLocationStatusUpdate,
  LIVE_COALESCE_MS,
  LIVE_CHECK_MS,
  CLOSE_FORBIDDEN,
  CLOSE_UNAUTHENTICATED,
} = await import('./useLocationLiveRevision');

/** What the toast was told - one entry per reload with news. */
const toasts = vi.fn();

type Kind = 'leak' | 'climate';

const Probe = ({ locationId, kinds }: { locationId: number; kinds: readonly Kind[] }) => {
  const revisions = useLocationLiveRevision(locationId, kinds, toasts);
  return (
    <>
      <span data-testid="revision">{revisions.leak}</span>
      <span data-testid="climate">{revisions.climate}</span>
    </>
  );
};

let container: HTMLDivElement;
let root: Root;

const revision = () => container.querySelector('[data-testid="revision"]')?.textContent;
const climateRevision = () => container.querySelector('[data-testid="climate"]')?.textContent;
const LEAK_ONLY: readonly Kind[] = ['leak'];
const BOTH: readonly Kind[] = ['leak', 'climate'];
const OFF: readonly Kind[] = [];
const render = (locationId: number, enabled: boolean | readonly Kind[] = true) =>
  act(() =>
    root.render(
      <Probe
        locationId={locationId}
        kinds={enabled === true ? LEAK_ONLY : enabled === false ? OFF : enabled}
      />,
    ),
  );
const measurement = (
  socket: FakeSocket,
  alarm = false,
  id = 1,
  locationId = 12,
  kind?: Kind,
) =>
  socket.emit({
    type: 'location_status',
    location_id: locationId,
    reason: 'measurement',
    alarm,
    measurement_id: id,
    ...(kind ? { kind } : {}),
  });
const wait = (ms: number) => act(() => vi.advanceTimersByTime(ms));

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  FakeSocket.instances = [];
  toasts.mockClear();
  api.latest = 100;
  api.latestOf = {};
  api.status = 200;
  api.calls = 0;
  api.urls = [];
  localStorage.setItem('authToken', 'jwt-token');
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  localStorage.clear();
});

describe('useLocationLiveRevision - socket', () => {
  it("opens the location's own socket and logs in with the page's JWT", () => {
    render(12);
    const [socket] = FakeSocket.instances;
    expect(socket.url).toMatch(/\/ws\/location\/12\/status\/$/);
    act(() => socket.onopen?.());
    expect(socket.sent.map((data) => JSON.parse(data))).toEqual([
      { type: 'auth', token: 'jwt-token' },
    ]);
  });

  it('reloads on every measurement and tells the toast', () => {
    render(12);
    const [socket] = FakeSocket.instances;
    expect(revision()).toBe('0');

    act(() => measurement(socket, false, 101));
    wait(LIVE_COALESCE_MS);
    expect(revision()).toBe('1');
    expect(toasts).toHaveBeenLastCalledWith({ count: 1, alarm: false, kind: 'leak' });
  });

  it('reloads once for measurements close together - one toast, alarm if any had one', () => {
    render(12);
    const [socket] = FakeSocket.instances;
    act(() => {
      measurement(socket, false, 101);
      measurement(socket, true, 102);
    });
    wait(LIVE_COALESCE_MS);
    expect(revision()).toBe('1');
    expect(toasts).toHaveBeenCalledTimes(1);
    expect(toasts).toHaveBeenCalledWith({ count: 2, alarm: true, kind: 'leak' });
  });

  it('ignores heartbeats and other locations', () => {
    render(12);
    const [socket] = FakeSocket.instances;
    act(() => {
      socket.emit({ type: 'heartbeat' });
      measurement(socket, true, 101, 13);
    });
    wait(LIVE_COALESCE_MS);
    expect(revision()).toBe('0');
    expect(toasts).not.toHaveBeenCalled();
  });

  it('opens no socket and checks nothing while disabled, closes it on leaving', () => {
    render(12, false);
    expect(FakeSocket.instances).toHaveLength(0);
    expect(api.calls).toBe(0);

    render(12);
    const [socket] = FakeSocket.instances;
    render(12, false);
    expect(socket.closed).toBe(true);
    // Closed on purpose: no reconnect.
    wait(10 * 60_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('gives up - socket and checks - when the user has no access', () => {
    render(12);
    act(() => FakeSocket.instances[0].onclose?.({ code: CLOSE_FORBIDDEN }));
    const calls = api.calls;
    api.latest = 200;
    wait(10 * 60_000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(api.calls).toBe(calls);
    expect(revision()).toBe('0');
  });

  it('tries again later when not logged in yet', () => {
    render(12);
    act(() => FakeSocket.instances[0].onclose?.({ code: CLOSE_UNAUTHENTICATED }));
    wait(5_000);
    expect(FakeSocket.instances).toHaveLength(2);
  });
});

describe('useLocationLiveRevision - background check', () => {
  it('checks when the page opens - what it loads is the start, no reload', () => {
    render(12);
    expect(api.calls).toBe(1);
    wait(LIVE_COALESCE_MS);
    expect(revision()).toBe('0');
  });

  it('refetches after a reconnect when newer data came meanwhile - no reload without', () => {
    render(12);
    act(() => FakeSocket.instances[0].onopen?.());

    // Down and back, nothing new: only the check.
    act(() => FakeSocket.instances[0].onclose?.({ code: 1006 }));
    wait(5_000);
    act(() => FakeSocket.instances[1].onopen?.());
    wait(LIVE_COALESCE_MS);
    expect(api.calls).toBe(2);
    expect(revision()).toBe('0');

    // Down and back, a measurement came meanwhile.
    api.latest = 101;
    act(() => FakeSocket.instances[1].onclose?.({ code: 1006 }));
    wait(5_000);
    act(() => FakeSocket.instances[2].onopen?.());
    wait(LIVE_COALESCE_MS);
    expect(revision()).toBe('1');
    expect(toasts).toHaveBeenLastCalledWith({ count: null, alarm: false, kind: 'leak' });
  });

  it('checks every minute while the socket is down', () => {
    render(12);
    // Never opens.
    api.latest = 101;
    wait(LIVE_CHECK_MS + LIVE_COALESCE_MS);
    expect(revision()).toBe('1');
    expect(toasts).toHaveBeenLastCalledWith({ count: null, alarm: false, kind: 'leak' });
  });

  it('checks rarely while the socket is up', () => {
    render(12);
    const [socket] = FakeSocket.instances;
    act(() => socket.onopen?.());
    // The backend's heartbeats keep it up (the watchdog closes a silent one).
    for (let second = 0; second < 2 * LIVE_CHECK_MS; second += 20_000) {
      act(() => socket.emit({ type: 'heartbeat' }));
      wait(20_000);
    }
    expect(api.calls).toBe(1);
  });

  it('a measurement the socket announced is not found again by the check', () => {
    render(12);
    const [socket] = FakeSocket.instances;
    act(() => socket.onopen?.());
    act(() => measurement(socket, false, 101));
    wait(LIVE_COALESCE_MS);
    expect(revision()).toBe('1');

    api.latest = 101;
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    wait(LIVE_COALESCE_MS);
    expect(revision()).toBe('1');
  });

  it('checks when the tab is shown again', () => {
    render(12);
    api.latest = 105;
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    wait(LIVE_COALESCE_MS);
    expect(revision()).toBe('1');
  });

  it('stops checking when access is gone', () => {
    render(12);
    api.status = 403;
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    const calls = api.calls;
    api.status = 200;
    api.latest = 200;
    wait(10 * LIVE_CHECK_MS);
    expect(api.calls).toBe(calls);
  });
});

describe('parseLocationStatusUpdate', () => {
  it('accepts only location_status of the location', () => {
    expect(
      parseLocationStatusUpdate(
        '{"type":"location_status","location_id":5,"alarm":true,"measurement_id":9}',
        5,
      ),
    ).toEqual({ alarm: true, measurementId: 9, kind: 'leak' });
    expect(
      parseLocationStatusUpdate('{"type":"location_status","location_id":5}', 5),
    ).toEqual({ alarm: false, measurementId: null, kind: 'leak' });
    expect(
      parseLocationStatusUpdate('{"type":"location_status","location_id":6}', 5),
    ).toBeNull();
    expect(parseLocationStatusUpdate('{"type":"heartbeat"}', 5)).toBeNull();
    expect(parseLocationStatusUpdate('not json', 5)).toBeNull();
  });
});

describe('parseLocationStatusUpdate - kind', () => {
  it('reads the kind - a message without one (older backend) is leak', () => {
    expect(
      parseLocationStatusUpdate(
        '{"type":"location_status","location_id":5,"kind":"climate"}',
        5,
      )?.kind,
    ).toBe('climate');
    expect(
      parseLocationStatusUpdate('{"type":"location_status","location_id":5}', 5)?.kind,
    ).toBe('leak');
    expect(
      parseLocationStatusUpdate(
        '{"type":"location_status","location_id":5,"kind":"wind"}',
        5,
      )?.kind,
    ).toBe('leak');
  });
});

describe('useLocationLiveRevision - leak and climate', () => {
  it('counts each kind on its own - one reload and one toast per kind', () => {
    render(12, BOTH);
    const [socket] = FakeSocket.instances;
    act(() => {
      measurement(socket, false, 101, 12, 'leak');
      measurement(socket, false, 102, 12, 'climate');
    });
    wait(LIVE_COALESCE_MS);
    expect(revision()).toBe('1');
    expect(climateRevision()).toBe('1');
    expect(toasts).toHaveBeenCalledTimes(2);
    expect(toasts).toHaveBeenCalledWith({ count: 1, alarm: false, kind: 'leak' });
    expect(toasts).toHaveBeenCalledWith({ count: 1, alarm: false, kind: 'climate' });

    act(() => measurement(socket, false, 103, 12, 'climate'));
    wait(LIVE_COALESCE_MS);
    expect(revision()).toBe('1');
    expect(climateRevision()).toBe('2');
  });

  it('checks each kind of a mixed location - only the leak one alone without ?kind=', () => {
    render(12, BOTH);
    expect(api.urls).toEqual([
      '/v1/location/12/latest-measurement/?kind=leak',
      '/v1/location/12/latest-measurement/?kind=climate',
    ]);

    api.latestOf = { leak: 101, climate: 100 };
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    wait(LIVE_COALESCE_MS);
    expect(revision()).toBe('1');
    expect(climateRevision()).toBe('0');
  });

  it('a single kind checks as before, without ?kind=', () => {
    render(12);
    expect(api.urls).toEqual(['/v1/location/12/latest-measurement/']);
  });

  it('no kinds: no socket, no checks', () => {
    render(12, OFF);
    expect(FakeSocket.instances).toHaveLength(0);
    expect(api.calls).toBe(0);
    expect(revision()).toBe('0');
    expect(climateRevision()).toBe('0');
  });
});
