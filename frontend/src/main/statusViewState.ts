import {
  HEAT_PROFILES,
  type HeatProfile,
} from '../components/device/sensorHeatmapTypes';
import { rangeContaining } from './statusAt';
import {
  LATEST_RANGE,
  TIME_RANGE_DAYS,
  type StatusRange,
  type TimeRange,
  isTimeRange,
} from './timeRanges';
import { locationPagePath } from './portalNav';

/**
 * What the status page of a location shows - its view, period, step, the
 * plan's frame, the sensor picked on the plan, the Zeitreihe's sensors and
 * the heat profile. An escalation keeps it (ProgeoEscalation.view_state,
 * backend escalation_viewset.clean_view_state) and its quick link opens the
 * page like that: /location/<id>/status?view=…&range=…&step=…&at=…&sensor=…&sensors=…&profile=…
 */
export type StatusViewState = {
  view?: 'roof' | 'zeitreihe';
  range?: StatusRange;
  /** The plan's step in seconds (picked in its dropdown). */
  step?: number;
  /** The plan's frame: its time (ISO-8601). */
  at?: string;
  /** The sensor picked on the plan. */
  sensor?: number;
  /** The Zeitreihe's sensors (its entry ids: "sensor-3", "3:0"). */
  sensors?: string[];
  profile?: HeatProfile;
};

const SENSOR_ID = /^(sensor-\d{1,6}|\d{1,6}:\d{1,4})$/;
const SENSORS_MAX = 100;

// -- the open status page -------------------------------------------------------------

// The status page of the open location keeps it up to date; the escalation
// dialog takes it along. One location at a time (the page remounts per location).
let published: { locationId: number; state: StatusViewState } | null = null;

/** The status page shows `patch` now (undefined values drop the setting). */
export const updateStatusView = (
  locationId: number,
  patch: StatusViewState,
) => {
  const base = published?.locationId === locationId ? published.state : {};
  published = { locationId, state: { ...base, ...patch } };
};

/** The status page of `locationId` was left. */
export const clearStatusView = (locationId: number) => {
  if (published?.locationId === locationId) {
    published = null;
  }
};

/**
 * What the status page of `locationId` shows now - null when it isn't open.
 * Only what the view uses: the plan's frame on the roof view, the
 * Zeitreihe's sensors on the Zeitreihe.
 */
export const currentStatusView = (
  locationId: number,
): StatusViewState | null => {
  if (published?.locationId !== locationId) {
    return null;
  }
  const { at, sensors, ...rest } = published.state;
  const state: StatusViewState =
    rest.view === 'zeitreihe' ? { ...rest, sensors } : { ...rest, at };
  return compact(state);
};

const compact = (state: StatusViewState): StatusViewState | null => {
  const entries = Object.entries(state).filter(([, value]) =>
    Array.isArray(value)
      ? value.length > 0
      : value !== undefined && value !== null,
  );
  return entries.length
    ? (Object.fromEntries(entries) as StatusViewState)
    : null;
};

// -- as URL ------------------------------------------------------------------------------

/** The query of the status page showing `state`. */
const statusViewSearch = (
  state: StatusViewState | null | undefined,
): string => {
  const params = new URLSearchParams();
  if (state?.view) {
    params.set('view', state.view);
  }
  if (state?.range) {
    params.set('range', state.range);
  }
  if (state?.step) {
    params.set('step', String(state.step));
  }
  if (state?.at) {
    params.set('at', state.at);
  }
  if (state?.sensor != null) {
    params.set('sensor', String(state.sensor));
  }
  if (state?.sensors?.length) {
    params.set('sensors', state.sensors.join(','));
  }
  if (state?.profile) {
    params.set('profile', state.profile);
  }
  return params.toString();
};

/** The status page of `location` showing `state` - the escalation's quick link. */
export const statusViewPath = (
  location: { id: number; project_id?: number | null },
  state: StatusViewState | null | undefined,
) => locationPagePath(location, 'status', statusViewSearch(state));

const positiveInt = (raw: string | null, max: number): number | undefined => {
  if (!raw || !/^\d{1,9}$/.test(raw)) {
    return undefined;
  }
  const value = Number(raw);
  return value > 0 && value <= max ? value : undefined;
};

/**
 * The view settings of the status page's URL - every one checked, the
 * invalid ones left out (the page's defaults then). `at` stays with
 * parseStatusAt (the page reads it itself).
 */
export const parseStatusView = (params: URLSearchParams): StatusViewState => {
  const state: StatusViewState = {};
  const view = params.get('view');
  if (view === 'roof' || view === 'zeitreihe') {
    state.view = view;
  }
  const range = params.get('range');
  if (range && (range === LATEST_RANGE || isTimeRange(range))) {
    state.range = range;
  }
  const step = positiveInt(params.get('step'), 31 * 24 * 3600);
  if (step) {
    state.step = step;
  }
  const sensorRaw = params.get('sensor');
  if (sensorRaw && /^\d{1,6}$/.test(sensorRaw)) {
    state.sensor = Number(sensorRaw);
  }
  const sensors = (params.get('sensors') ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => SENSOR_ID.test(id))
    .slice(0, SENSORS_MAX);
  if (sensors.length) {
    state.sensors = [...new Set(sensors)];
  }
  const profile = params.get('profile');
  if (profile && (HEAT_PROFILES as readonly string[]).includes(profile)) {
    state.profile = profile as HeatProfile;
  }
  return state;
};

/** A key of the parsed settings - the page applies them again when it changes. */
export const statusViewKey = (state: StatusViewState) =>
  statusViewSearch(state);

/** Whether `range` (the last N days up to `now`) still reaches back to `at`
 * - the latest measurement reaches back to no moment. */
export const rangeReaches = (range: StatusRange, at: number, now: number) =>
  isTimeRange(range) &&
  now - at <= TIME_RANGE_DAYS[range] * 24 * 60 * 60 * 1000 * 0.95;

/** The range to switch to for showing `at`: null while `range` reaches back
 * to it, else the shortest of `candidates` that does (rangeContaining). */
export const rangeForMoment = (
  range: StatusRange,
  at: number,
  now: number,
  candidates: readonly TimeRange[],
): TimeRange | null =>
  rangeReaches(range, at, now) ? null : rangeContaining(at, now, candidates);

/**
 * Where the URL's settings put the page: the requested range and step - or,
 * with a moment (?at=, `focusAt`) the requested range doesn't reach back to,
 * the shortest of `candidates` that does, its default step (null) and the
 * roof view unless a view was asked for (`roof`).
 */
const statusViewFocus = (
  requested: StatusViewState,
  focusAt: number | null,
  now: number,
  candidates: readonly TimeRange[],
): { range: StatusRange | null; step: number | null; roof: boolean } => {
  const range = requested.range ?? null;
  if (focusAt == null || (range && rangeReaches(range, focusAt, now))) {
    return { range, step: requested.step ?? null, roof: false };
  }
  return {
    range: rangeContaining(focusAt, now, candidates),
    step: null,
    roof: !requested.view,
  };
};

/**
 * The page's settings by the URL (see statusViewFocus) - undefined: keep
 * the current one. The heat profile is staff's only; the step goes with
 * the range (null: the range's default).
 */
export const requestedSettings = (
  requested: StatusViewState,
  focusAt: number | null,
  now: number,
  candidates: readonly TimeRange[],
  isStaff: boolean,
): {
  view?: 'roof' | 'zeitreihe';
  sensor?: number;
  profile?: HeatProfile;
  range?: StatusRange;
  step?: number | null;
} => {
  const focus = statusViewFocus(requested, focusAt, now, candidates);
  return {
    view: requested.view ?? (focus.roof ? 'roof' : undefined),
    sensor: requested.sensor,
    profile: isStaff ? requested.profile : undefined,
    range: focus.range ?? undefined,
    step: focus.range ? focus.step : undefined,
  };
};
