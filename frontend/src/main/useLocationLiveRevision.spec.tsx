// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The status socket - its messages are sent by the tests. */
class FakeSocket {
  static instances: FakeSocket[] = [];
  url: string;
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
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

const {
  useLocationLiveRevision,
  isLocationStatusUpdate,
  LIVE_COALESCE_MS,
  CLOSE_FORBIDDEN,
} = await import('./useLocationLiveRevision');

const Probe = ({ locationId, enabled }: { locationId: number; enabled: boolean }) => (
  <span data-testid="revision">{useLocationLiveRevision(locationId, enabled)}</span>
);

let container: HTMLDivElement;
let root: Root;

const revision = () => container.querySelector('[data-testid="revision"]')?.textContent;
const render = (locationId: number, enabled = true) =>
  act(() => root.render(<Probe locationId={locationId} enabled={enabled} />));

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  FakeSocket.instances = [];
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe('useLocationLiveRevision', () => {
  it("opens the location's own socket and counts its announcements", () => {
    render(12);
    const [socket] = FakeSocket.instances;
    expect(socket.url).toMatch(/\/ws\/location\/12\/status\/$/);
    expect(revision()).toBe('0');

    act(() => {
      socket.emit({ type: 'location_status', location_id: 12, reason: 'alarm' });
      vi.advanceTimersByTime(LIVE_COALESCE_MS);
    });
    expect(revision()).toBe('1');
  });

  it('reloads once for announcements close together', () => {
    render(12);
    const [socket] = FakeSocket.instances;
    act(() => {
      socket.emit({ type: 'location_status', location_id: 12 });
      socket.emit({ type: 'location_status', location_id: 12 });
      vi.advanceTimersByTime(LIVE_COALESCE_MS);
    });
    expect(revision()).toBe('1');
  });

  it('ignores heartbeats and other locations', () => {
    render(12);
    const [socket] = FakeSocket.instances;
    act(() => {
      socket.emit({ type: 'heartbeat' });
      socket.emit({ type: 'location_status', location_id: 13 });
      vi.advanceTimersByTime(LIVE_COALESCE_MS);
    });
    expect(revision()).toBe('0');
  });

  it('opens no socket while disabled, and closes it on leaving', () => {
    render(12, false);
    expect(FakeSocket.instances).toHaveLength(0);

    render(12);
    const [socket] = FakeSocket.instances;
    render(12, false);
    expect(socket.closed).toBe(true);
    // Closed on purpose: no reconnect.
    act(() => vi.advanceTimersByTime(10 * 60_000));
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('gives up when the backend rejects the user (no access)', () => {
    render(12);
    act(() => FakeSocket.instances[0].onclose?.({ code: CLOSE_FORBIDDEN }));
    act(() => vi.advanceTimersByTime(10 * 60_000));
    expect(FakeSocket.instances).toHaveLength(1);
    expect(revision()).toBe('0');
  });

  it('reconnects after the socket dropped', () => {
    render(12);
    act(() => FakeSocket.instances[0].onclose?.({ code: 1006 }));
    act(() => vi.advanceTimersByTime(5_000));
    expect(FakeSocket.instances).toHaveLength(2);
  });
});

describe('isLocationStatusUpdate', () => {
  it('accepts only location_status of the location', () => {
    expect(isLocationStatusUpdate('{"type":"location_status","location_id":5}', 5)).toBe(true);
    expect(isLocationStatusUpdate('{"type":"location_status","location_id":6}', 5)).toBe(false);
    expect(isLocationStatusUpdate('{"type":"heartbeat"}', 5)).toBe(false);
    expect(isLocationStatusUpdate('not json', 5)).toBe(false);
  });
});
