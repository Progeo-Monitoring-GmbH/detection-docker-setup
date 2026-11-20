import { useEffect, useState } from 'react';
import { getWsBaseUrl } from '../backendUrl';

/** The socket of a location's status pages (backend LocationStatusConsumer). */
export const locationStatusSocketPath = (locationId: number) =>
  `/ws/location/${locationId}/status/`;

/** The backend's heartbeat comes every 20 s - silence this long: reconnect. */
const SOCKET_WATCHDOG_MS = 60_000;
const RECONNECT_MIN_MS = 5_000;
const RECONNECT_MAX_MS = 120_000;
/** Messages this close together (several devices at once) reload once. */
export const LIVE_COALESCE_MS = 1_000;
/** Closed by the backend: no access to the location - no reconnect
 * (the backend accepts and then closes, so this code reaches the browser). */
export const CLOSE_FORBIDDEN = 4403;

/** Whether a socket message announces new data of `locationId`. */
export const isLocationStatusUpdate = (data: unknown, locationId: number) => {
  if (typeof data !== 'string') {
    return false;
  }
  try {
    const message = JSON.parse(data) as { type?: string; location_id?: number };
    return (
      message?.type === 'location_status' &&
      Number(message.location_id) === locationId
    );
  } catch {
    return false;
  }
};

/**
 * New data of the location while its status page is open: a counter that
 * goes up whenever the backend announces some (a controller sample with
 * alarm=1) - the page's data hooks reload on it. Starts at 0; stays there
 * while `enabled` is false, without the socket or without access.
 */
export const useLocationLiveRevision = (
  locationId: number,
  enabled: boolean,
): number => {
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!enabled || typeof WebSocket === 'undefined') {
      return undefined;
    }
    let disposed = false;
    let socket: WebSocket | null = null;
    let watchdog: number | undefined;
    let reconnectTimer: number | undefined;
    let coalesceTimer: number | undefined;
    let reconnectDelay = RECONNECT_MIN_MS;

    const armWatchdog = () => {
      window.clearTimeout(watchdog);
      watchdog = window.setTimeout(() => socket?.close(), SOCKET_WATCHDOG_MS);
    };
    const bump = () => {
      if (coalesceTimer !== undefined) {
        return;
      }
      coalesceTimer = window.setTimeout(() => {
        coalesceTimer = undefined;
        if (!disposed) {
          setRevision((value) => value + 1);
        }
      }, LIVE_COALESCE_MS);
    };
    const connect = () => {
      if (disposed) {
        return;
      }
      const ws = new WebSocket(
        `${getWsBaseUrl()}${locationStatusSocketPath(locationId)}`,
      );
      socket = ws;
      ws.onopen = () => {
        reconnectDelay = RECONNECT_MIN_MS;
        armWatchdog();
      };
      ws.onmessage = (event) => {
        armWatchdog();
        if (isLocationStatusUpdate(event.data, locationId)) {
          bump();
        }
      };
      ws.onclose = (event) => {
        window.clearTimeout(watchdog);
        if (disposed || event.code === CLOSE_FORBIDDEN) {
          return;
        }
        reconnectTimer = window.setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
      };
    };
    connect();

    return () => {
      disposed = true;
      window.clearTimeout(watchdog);
      window.clearTimeout(reconnectTimer);
      window.clearTimeout(coalesceTimer);
      socket?.close();
    };
  }, [enabled, locationId]);

  return revision;
};

export default useLocationLiveRevision;
