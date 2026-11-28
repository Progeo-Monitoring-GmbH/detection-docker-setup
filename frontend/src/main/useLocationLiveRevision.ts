import { useEffect, useState } from 'react';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig';
import { getWsBaseUrl } from '../backendUrl';
import { useLatestRef } from '../components/ui/useLatestRef';
import type { DeviceKind } from './locationTypes';

/** The socket of a location's status pages (backend LocationStatusConsumer). */
const locationStatusSocketPath = (locationId: number) =>
  `/ws/location/${locationId}/status/`;

/** The cheap "is there new data?" check of a location - of one device kind
 * (a location with leak devices and climate sensors), else of all of them. */
const latestMeasurementUrl = (locationId: number, kind: DeviceKind | null) =>
  `/v1/location/${locationId}/latest-measurement/${kind ? `?kind=${kind}` : ''}`;

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
const LIVE_CHECK_SOCKET_MS = 5 * 60_000;

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
type LocationStatusUpdate = {
  alarm: boolean;
  measurementId: number | null;
  /** The device's kind - "leak" when the message names none (older backend). */
  kind: DeviceKind;
};

const KIND_NAMES: readonly DeviceKind[] = ['leak', 'climate'];

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
      kind?: string;
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
      kind: KIND_NAMES.find((kind) => kind === message.kind) ?? 'leak',
    };
  } catch {
    return null;
  }
};

/** New measurements of one device kind since its last reload: `count`
 * announced by the socket (within LIVE_COALESCE_MS) - null when the
 * background check found newer data (how many is unknown); `alarm` if one
 * reported an alarm. */
export type LiveMeasurements = { count: number | null; alarm: boolean; kind: DeviceKind };

/** A reload counter per device kind. */
export type LiveRevisions = Record<DeviceKind, number>;

export const NO_LIVE_REVISIONS: LiveRevisions = { leak: 0, climate: 0 };

/** What one kind keeps between the socket's messages and its checks. */
type KindState = {
  /** The newest measurement the page knows of; undefined until the first check. */
  known: number | null | undefined;
  checking: boolean;
  /** No access: no further checks of this kind. */
  stopped: boolean;
  /** What arrived since the last reload. */
  pending: { count: number | null; alarm: boolean } | null;
  coalesceTimer: number | undefined;
};

/**
 * Keeps an open status page up to date with little traffic: the page shows
 * what it loaded, and this says when there is something newer - a counter
 * per device kind that goes up then (the data hooks of that kind's tab
 * reload on it) and `onMeasurements` (for a toast), once per kind.
 *
 * - The socket announces every controller sample right away, with its kind.
 * - A cheap check (the id of the newest measurement, per kind) runs when
 *   the page opens, when the socket is back after it was down, when the
 *   tab is shown again, and every LIVE_CHECK_MS while the socket is down
 *   (LIVE_CHECK_SOCKET_MS while it is up). Only a newer id reloads. With a
 *   single kind it asks without ?kind= (as before the tabs), and every
 *   announcement counts for that kind.
 *
 * `kinds`: the kinds followed - empty: off (no socket, no checks). Every
 * revision starts at 0 and stays there without access.
 */
export const useLocationLiveRevision = (
  locationId: number,
  kinds: readonly DeviceKind[],
  onMeasurements?: (measurements: LiveMeasurements) => void,
): LiveRevisions => {
  const auth = useAuth();
  const [revisions, setRevisions] = useState<LiveRevisions>(NO_LIVE_REVISIONS);
  // The latest callback / auth, without opening the socket again when they change.
  const latest = useLatestRef({ onMeasurements, auth });
  // A new array with the same kinds is no reason to reconnect.
  const kindsKey = kinds.join(',');

  useEffect(() => {
    const followed = kindsKey ? (kindsKey.split(',') as DeviceKind[]) : [];
    if (followed.length === 0) {
      return undefined;
    }
    const perKind = followed.length > 1;
    let disposed = false;
    // No access: neither the socket nor the checks go on.
    let stopped = false;
    let socket: WebSocket | null = null;
    let socketOpen = false;
    let watchdog: number | undefined;
    let reconnectTimer: number | undefined;
    let reconnectDelay = RECONNECT_MIN_MS;
    let attempts = 0;
    let lastCheck = 0;
    const states = new Map<DeviceKind, KindState>(
      followed.map((kind) => [
        kind,
        { known: undefined, checking: false, stopped: false, pending: null, coalesceTimer: undefined },
      ]),
    );

    const reload = (kind: DeviceKind, state: KindState) => {
      if (state.coalesceTimer !== undefined) {
        return;
      }
      state.coalesceTimer = window.setTimeout(() => {
        state.coalesceTimer = undefined;
        const arrived = state.pending;
        state.pending = null;
        if (disposed || !arrived) {
          return;
        }
        setRevisions((value) => ({ ...value, [kind]: value[kind] + 1 }));
        latest.current.onMeasurements?.({ ...arrived, kind });
      }, LIVE_COALESCE_MS);
    };
    /** `count` new measurements of `kind` (null: some, found by the check). */
    const newData = (kind: DeviceKind, count: number | null, alarm: boolean) => {
      const state = states.get(kind);
      if (!state) {
        return;
      }
      const { pending } = state;
      const counted =
        count === null || (pending !== null && pending.count === null)
          ? null
          : (pending?.count ?? 0) + count;
      state.pending = { count: counted, alarm: Boolean(pending?.alarm) || alarm };
      reload(kind, state);
    };
    const knowOf = (kind: DeviceKind, id: number | null) => {
      const state = states.get(kind);
      if (state && id !== null && (state.known == null || id > state.known)) {
        state.known = id;
      }
    };

    const checkKind = (kind: DeviceKind, state: KindState) => {
      if (state.checking || state.stopped) {
        return;
      }
      state.checking = true;
      void axiosConfig.perform_get(
        latest.current.auth,
        latestMeasurementUrl(locationId, perKind ? kind : null),
        (response: { data?: { id?: unknown } }) => {
          state.checking = false;
          if (disposed) {
            return;
          }
          const raw = response?.data?.id;
          const id = typeof raw === 'number' ? raw : null;
          if (state.known === undefined) {
            // The first check: what the page is loading right now.
            state.known = id;
          } else if (id !== null && (state.known === null || id > state.known)) {
            state.known = id;
            newData(kind, null, false);
          }
        },
        (error: { response?: { status?: number } }) => {
          state.checking = false;
          const status = error?.response?.status;
          // No access (any more) / no such location: no further checks.
          if (status === 403 || status === 404) {
            state.stopped = true;
          }
        },
      );
    };
    const check = () => {
      if (disposed || stopped) {
        return;
      }
      lastCheck = Date.now();
      states.forEach((state, kind) => checkKind(kind, state));
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
          // A single kind followed: every announcement counts for it.
          const kind = perKind ? update.kind : followed[0];
          knowOf(kind, update.measurementId);
          newData(kind, 1, update.alarm);
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
      states.forEach((state) => window.clearTimeout(state.coalesceTimer));
      document.removeEventListener('visibilitychange', onVisible);
      socket?.close();
    };
  }, [kindsKey, locationId, latest]);

  return revisions;
};
