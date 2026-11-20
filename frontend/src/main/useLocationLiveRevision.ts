import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig';
import { getWsBaseUrl } from '../backendUrl';

/** The socket of a location's status pages (backend LocationStatusConsumer). */
export const locationStatusSocketPath = (locationId: number) =>
  `/ws/location/${locationId}/status/`;

/** The cheap "is there new data?" check of a location. */
export const latestMeasurementUrl = (locationId: number) =>
  `/v1/location/${locationId}/latest-measurement/`;

/** The backend's heartbeat comes every 20 s - silence this long: reconnect. */
const SOCKET_WATCHDOG_MS = 60_000;
const RECONNECT_MIN_MS = 5_000;
const RECONNECT_MAX_MS = 120_000;
/** Messages this close together (several devices at once) reload once. */
export const LIVE_COALESCE_MS = 1_000;
/** Closed by the backend: no access to the location - no reconnect, no
 * checks (the backend accepts and then closes, so this code reaches the
 * browser). */
export const CLOSE_FORBIDDEN = 4403;
/** Closed by the backend: no valid login (yet) - tried again later, with
 * the token the page has then. */
export const CLOSE_UNAUTHENTICATED = 4401;
/** The check runs this often while the socket is down... */
export const LIVE_CHECK_MS = 60_000;
/** ...and this often while it is up - in case an announcement got lost. */
export const LIVE_CHECK_SOCKET_MS = 5 * 60_000;

/** The SPA's login (a JWT): the socket's first message - a browser can't
 * send headers with a websocket, and magic-link logins have no session. */
const authToken = () => {
  try {
    return localStorage.getItem('authToken');
  } catch {
    return null;
  }
};

/** A new measurement of the location, as the backend announces it. */
type LocationStatusUpdate = { alarm: boolean; measurementId: number | null };

/** The announcement of new data of `locationId` in a socket message - null
 * for anything else (heartbeats, another location, no JSON). */
export const parseLocationStatusUpdate = (
  data: unknown,
  locationId: number,
): LocationStatusUpdate | null => {
  if (typeof data !== 'string') {
    return null;
  }
  try {
    const message = JSON.parse(data) as {
      type?: string;
      location_id?: number;
      alarm?: boolean;
      measurement_id?: number | null;
    };
    if (
      message?.type !== 'location_status' ||
      Number(message.location_id) !== locationId
    ) {
      return null;
    }
    return {
      alarm: Boolean(message.alarm),
      measurementId:
        typeof message.measurement_id === 'number' ? message.measurement_id : null,
    };
  } catch {
    return null;
  }
};

/** New measurements since the last reload: `count` announced by the socket
 * (within LIVE_COALESCE_MS) - null when the background check found newer
 * data (how many is unknown); `alarm` if one reported an alarm. */
export type LiveMeasurements = { count: number | null; alarm: boolean };

/**
 * Keeps an open status page up to date with little traffic: the page shows
 * what it loaded, and this says when there is something newer - a counter
 * that goes up then (the page's data hooks reload on it) and
 * `onMeasurements` (for a toast).
 *
 * - The socket announces every controller sample right away.
 * - A cheap check (the id of the newest measurement) runs when the page
 *   opens, when the socket is back after it was down, when the tab is shown
 *   again, and every LIVE_CHECK_MS while the socket is down
 *   (LIVE_CHECK_SOCKET_MS while it is up). Only a newer id reloads.
 *
 * Starts at 0; stays there while `enabled` is false or without access.
 */
export const useLocationLiveRevision = (
  locationId: number,
  enabled: boolean,
  onMeasurements?: (measurements: LiveMeasurements) => void,
): number => {
  const auth = useAuth();
  const [revision, setRevision] = useState(0);
  // The latest callback / auth, without opening the socket again when they change.
  const latest = useRef({ onMeasurements, auth });
  useEffect(() => {
    latest.current = { onMeasurements, auth };
  });

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }
    let disposed = false;
    // No access: neither the socket nor the checks go on.
    let stopped = false;
    let socket: WebSocket | null = null;
    let socketOpen = false;
    let watchdog: number | undefined;
    let reconnectTimer: number | undefined;
    let coalesceTimer: number | undefined;
    let reconnectDelay = RECONNECT_MIN_MS;
    let attempts = 0;
    // The newest measurement the page knows of; undefined until the first check.
    let known: number | null | undefined;
    let checking = false;
    let lastCheck = 0;
    // What arrived since the last reload.
    let pending: LiveMeasurements | null = null;

    const reload = () => {
      if (coalesceTimer !== undefined) {
        return;
      }
      coalesceTimer = window.setTimeout(() => {
        coalesceTimer = undefined;
        const arrived = pending;
        pending = null;
        if (disposed || !arrived) {
          return;
        }
        setRevision((value) => value + 1);
        latest.current.onMeasurements?.(arrived);
      }, LIVE_COALESCE_MS);
    };
    /** `count` new measurements (null: some, found by the check). */
    const newData = (count: number | null, alarm: boolean) => {
      const counted =
        count === null || (pending !== null && pending.count === null)
          ? null
          : (pending?.count ?? 0) + count;
      pending = { count: counted, alarm: Boolean(pending?.alarm) || alarm };
      reload();
    };
    const knowOf = (id: number | null) => {
      if (id !== null && (known == null || id > known)) {
        known = id;
      }
    };

    const check = () => {
      if (disposed || stopped || checking) {
        return;
      }
      checking = true;
      lastCheck = Date.now();
      void axiosConfig.perform_get(
        latest.current.auth,
        latestMeasurementUrl(locationId),
        (response: { data?: { id?: unknown } }) => {
          checking = false;
          if (disposed) {
            return;
          }
          const raw = response?.data?.id;
          const id = typeof raw === 'number' ? raw : null;
          if (known === undefined) {
            // The first check: what the page is loading right now.
            known = id;
          } else if (id !== null && (known === null || id > known)) {
            known = id;
            newData(null, false);
          }
        },
        (error: { response?: { status?: number } }) => {
          checking = false;
          const status = error?.response?.status;
          // No access (any more) / no such location: no further checks.
          if (status === 403 || status === 404) {
            stopped = true;
          }
        },
      );
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        check();
      }
    };
    const checkTimer = window.setInterval(() => {
      if (document.visibilityState === 'hidden') {
        return;
      }
      const every = socketOpen ? LIVE_CHECK_SOCKET_MS : LIVE_CHECK_MS;
      // A check that ran meanwhile (tab shown, reconnect) counts.
      if (Date.now() - lastCheck >= every - LIVE_CHECK_MS / 2) {
        check();
      }
    }, LIVE_CHECK_MS);

    const armWatchdog = () => {
      window.clearTimeout(watchdog);
      watchdog = window.setTimeout(() => socket?.close(), SOCKET_WATCHDOG_MS);
    };
    const connect = () => {
      if (disposed || stopped || typeof WebSocket === 'undefined') {
        return;
      }
      attempts += 1;
      const ws = new WebSocket(
        `${getWsBaseUrl()}${locationStatusSocketPath(locationId)}`,
      );
      socket = ws;
      ws.onopen = () => {
        socketOpen = true;
        reconnectDelay = RECONNECT_MIN_MS;
        armWatchdog();
        ws.send(JSON.stringify({ type: 'auth', token: authToken() }));
        // Not the first try: the socket was down (or never up) - what
        // arrived meanwhile wasn't announced.
        if (attempts > 1) {
          check();
        }
      };
      ws.onmessage = (event) => {
        armWatchdog();
        const update = parseLocationStatusUpdate(event.data, locationId);
        if (update) {
          knowOf(update.measurementId);
          newData(1, update.alarm);
        }
      };
      ws.onclose = (event) => {
        socketOpen = false;
        window.clearTimeout(watchdog);
        if (disposed) {
          return;
        }
        if (event.code === CLOSE_FORBIDDEN) {
          stopped = true;
          return;
        }
        // Dropped, or not logged in yet (CLOSE_UNAUTHENTICATED): again later.
        reconnectTimer = window.setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
      };
    };

    check();
    connect();
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      disposed = true;
      window.clearInterval(checkTimer);
      window.clearTimeout(watchdog);
      window.clearTimeout(reconnectTimer);
      window.clearTimeout(coalesceTimer);
      document.removeEventListener('visibilitychange', onVisible);
      socket?.close();
    };
  }, [enabled, locationId]);

  return revision;
};

export default useLocationLiveRevision;
