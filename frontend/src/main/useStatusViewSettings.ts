import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import type { HeatProfile } from '../components/device/sensorHeatmapTypes';
import { parseStatusAt } from './statusAt';
import {
  clearStatusView,
  parseStatusView,
  rangeForMoment,
  requestedSettings,
  statusViewKey,
  updateStatusView,
} from './statusViewState';
import {
  type StatusRange,
  type TimeRange,
  timeRangeCandidates,
} from './timeRanges';

export type StatusViewMode = 'roof' | 'zeitreihe';

/** A state update to `value` - none while it is undefined. */
const keepUnset =
  <T>(value: T | undefined) =>
  (current: T): T =>
    value === undefined ? current : value;

/** A moment asked for on the page (a Verdachtsstelle's first detection):
 * the plan's slider goes there - `revision` also when it is asked twice. */
type Jump = { at: number; revision: number };

const jumpedTo =
  (at: number) =>
  (prev: Jump | null): Jump => ({ at, revision: (prev?.revision ?? 0) + 1 });

/** The plan a jump asked for (a suspected leak's "Jump to Event"): shown
 * until another one is picked - `revision` also when it is asked twice,
 * counting on (also when reset) so no plan picked before wins again. */
type PlanJump = { plan: number | null; revision: number };

const planJumpedTo =
  (plan: number | null) =>
  (prev: PlanJump): PlanJump => ({ plan, revision: prev.revision + 1 });

const toggledSensor =
  (pos: number) =>
  (current: number | null): number | null =>
    current === pos ? null : pos;

/** The view the URL asks for: its settings (statusViewState.ts), the
 * moment of ?at= and a key that changes with either. */
const useRequestedView = () => {
  const [searchParams] = useSearchParams();
  const requested = useMemo(
    () => parseStatusView(searchParams),
    [searchParams],
  );
  const atParam = searchParams.get('at');
  const focusAt = useMemo(() => parseStatusAt(atParam), [atParam]);
  return {
    searchParams,
    requested,
    focusAt,
    requestKey: `${focusAt}|${statusViewKey(requested)}`,
  };
};

/**
 * What the status page shows - view, range, the plan's step, the picked
 * sensor and heat profile, a moment to jump to - and the settings of the
 * URL, applied when the page opens and whenever they change: an
 * escalation's quick link (view, range, step, sensor, sensors, profile -
 * statusViewState.ts) and ?at=<ISO-8601> (e.g. an event of the notification
 * history): the plan at that moment - a range that contains it, its frame
 * shown first.
 */
export const useStatusViewSettings = (isStaff: boolean) => {
  const [statusView, setStatusView] = useState<StatusViewMode>('roof');
  // The range of both views - the plan's frames and the Zeitreihe; or
  // "Letzte Messung" (LATEST_RANGE): the newest 10 measurements.
  const [selectedRange, setSelectedRange] = useState<StatusRange>('7d');
  // Step of the plan's frames, picked in its dropdown; null: the range's default.
  const [pickedStep, setPickedStep] = useState<number | null>(null);
  // "Now" until the data arrives (the parent remounts per location).
  const [openedAt] = useState(() => Date.now());
  // The sensor picked on the plan - the Zeitreihe's first entry.
  const [selectedSensor, setSelectedSensor] = useState<number | null>(null);
  // Staff: the plan's heat as another value per sensor (WP, EP, WP + EP) -
  // its own history, only for the heatmap; the Zeitreihe, the KPIs and the
  // sensor table keep |WP - EP| (the alarm value).
  const [heatProfile, setHeatProfile] = useState<HeatProfile>('diff');
  // The sensor hovered in a Verdachtsstelle's sensor list - pointed out on the plan.
  const [hoveredSensor, setHoveredSensor] = useState<number | null>(null);
  const [jump, setJump] = useState<Jump | null>(null);
  const [planJump, setPlanJump] = useState<PlanJump>({
    plan: null,
    revision: 0,
  });

  const { searchParams, requested, focusAt, requestKey } = useRequestedView();
  const [applied, setApplied] = useState<string | null>(null);
  if (applied !== requestKey) {
    setApplied(requestKey);
    // A new ?at= wins over a moment (and plan) asked for on the page.
    setJump(null);
    if (planJump.plan != null) {
      setPlanJump(planJumpedTo(null));
    }
    const next = requestedSettings(
      requested,
      focusAt,
      openedAt,
      timeRangeCandidates({ long: true, staff: isStaff }),
      isStaff,
    );
    // What the URL leaves out stays as it is.
    setStatusView(keepUnset(next.view));
    setSelectedSensor(keepUnset<number | null>(next.sensor));
    setHeatProfile(keepUnset(next.profile));
    setSelectedRange(keepUnset(next.range));
    setPickedStep(keepUnset(next.step));
  }

  /** Another range - its default step. */
  const selectRange = useCallback((range: StatusRange) => {
    setSelectedRange(range);
    setPickedStep(null);
  }, []);
  /** The plan's slider to a moment - and to its plan, given one. */
  const jumpTo = useCallback((at: number, plan?: number | null) => {
    setJump(jumpedTo(at));
    if (plan != null) {
      setPlanJump(planJumpedTo(plan));
    }
  }, []);
  /** A sensor picked on the plan - again: unpicked. */
  const toggleSensor = useCallback(
    (pos: number) => setSelectedSensor(toggledSensor(pos)),
    [],
  );

  return {
    searchParams,
    requested,
    focusAt,
    openedAt,
    statusView,
    setStatusView,
    selectedRange,
    selectRange,
    pickedStep,
    setPickedStep,
    selectedSensor,
    toggleSensor,
    heatProfile,
    setHeatProfile,
    hoveredSensor,
    setHoveredSensor,
    jump,
    jumpTo,
    planJump,
  };
};

/**
 * "Erstes Auftreten anzeigen": the plan's slider to that moment - in a
 * range that reaches back to it (the shortest available, as for ?at=).
 */
export const useShowMoment = (
  { jumpTo, selectRange }: ReturnType<typeof useStatusViewSettings>,
  range: StatusRange,
  now: number,
  rangeOptions: readonly TimeRange[],
) =>
  useCallback(
    (iso: string, plan?: number | null) => {
      const at = Date.parse(iso);
      if (!Number.isFinite(at)) {
        return;
      }
      jumpTo(at, plan);
      const reaching = rangeForMoment(range, at, now, rangeOptions);
      if (reaching) {
        selectRange(reaching);
      }
    },
    [jumpTo, selectRange, now, range, rangeOptions],
  );

/**
 * What the page shows - an escalation created now keeps it
 * (statusViewState.ts); the plan's frame and the Zeitreihe's sensors are
 * reported by their panels (the returned callbacks).
 */
export const usePublishedStatusView = (
  locationId: number,
  {
    view,
    range,
    step,
    sensor,
    profile,
  }: {
    view: StatusViewMode;
    range: StatusRange;
    step: number | null;
    sensor: number | null;
    profile: HeatProfile;
  },
) => {
  useEffect(() => {
    updateStatusView(locationId, {
      view,
      range,
      step: step ?? undefined,
      sensor: sensor ?? undefined,
      profile: profile === 'diff' ? undefined : profile,
    });
  }, [locationId, view, range, step, sensor, profile]);
  useEffect(() => () => clearStatusView(locationId), [locationId]);
  const onFrameTimeChange = useCallback(
    (ms: number | null) =>
      updateStatusView(locationId, {
        at: ms != null ? new Date(ms).toISOString() : undefined,
      }),
    [locationId],
  );
  const onZeitreiheShown = useCallback(
    (ids: string[]) =>
      updateStatusView(locationId, { sensors: ids.length ? ids : undefined }),
    [locationId],
  );
  return { onFrameTimeChange, onZeitreiheShown };
};
