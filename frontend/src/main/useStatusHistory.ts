import { useCallback, useMemo } from 'react';
import { useSnackbar } from 'notistack';
import { useTranslation } from 'react-i18next';
import {
  type HeatmapWindow,
  stepsForRange,
} from '../components/device/heatmapSteps';
import type { HeatProfile } from '../components/device/sensorHeatmapTypes';
import { historySpecFor } from './locationStatusData';
import {
  heatmapStepOf,
  liveMeasurementToast,
  planFramesOf,
  rangeDaysOf,
  rangeWindow,
  zeitreiheOf,
} from './locationStatusViewData';
import {
  availableTimeRanges,
  effectiveTimeRange,
  LATEST_RANGE,
  type MeasurementRange,
  type StatusRange,
  timeRangeCandidates,
} from './timeRanges';
import { useLocationHistory } from './useLocationHistory';
import type { DeviceKind } from './locationTypes';
import {
  type LiveMeasurements,
  type LiveRevisions,
  NO_LIVE_REVISIONS,
  useLocationLiveRevision,
} from './useLocationLiveRevision';
import { useMeasurementRangeState } from './useMeasurementRange';

/**
 * New data while the page is open (every controller sample, and whatever
 * came while the socket was down): a toast tells it, `onNewData` runs (the
 * page jumps to "Letzte Messung") and the range, the history, the
 * Verdachtsstellen and the KPIs reload quietly on the returned revision.
 *
 * Without `canSeeMeasurements` only the toast: the socket announces the
 * location's measurements to everyone who may see the location, but its
 * measurement data would be refused (403 - an error toast per measurement).
 *
 * Per device kind (`kinds` followed, empty: off): the revision of a kind
 * goes up with its new data, `onNewData(kind)` names it.
 */
export const useStatusLiveRevision = (
  locationId: number,
  kinds: readonly DeviceKind[],
  canSeeMeasurements: boolean,
  onNewData?: (kind: DeviceKind) => void,
): LiveRevisions => {
  const { t } = useTranslation();
  const { enqueueSnackbar } = useSnackbar();
  const onLiveMeasurements = useCallback(
    (measurements: LiveMeasurements) => {
      const toast = liveMeasurementToast(measurements);
      const message = toast.options
        ? t(toast.key, toast.options)
        : t(toast.key);
      enqueueSnackbar(message, { variant: toast.variant });
      if (canSeeMeasurements) {
        onNewData?.(measurements.kind);
      }
    },
    [canSeeMeasurements, enqueueSnackbar, onNewData, t],
  );
  const revisions = useLocationLiveRevision(locationId, kinds, onLiveMeasurements);
  return canSeeMeasurements ? revisions : NO_LIVE_REVISIONS;
};

/**
 * The location's measurement range - the history to load, and the long
 * ranges once the data reaches that far back (smartex io: LocationClimatePanels
 * does its own) - and the range shown of the picked one.
 */
export const useStatusRange = ({
  locationId,
  demo,
  isSmartexIo,
  isStaff,
  selectedRange,
  liveRevision,
  kind,
}: {
  locationId: number;
  demo: boolean;
  isSmartexIo: boolean;
  isStaff: boolean;
  selectedRange: StatusRange;
  liveRevision: number;
  /** Only the leak devices of a location with climate sensors too. */
  kind?: DeviceKind;
}) => {
  const {
    range: measurementRange,
    failed: measurementRangeFailed,
    // The history follows once the range of the new data is there (its
    // window ends at the newest measurement).
    revision: rangeRevision,
  } = useMeasurementRangeState(locationId, demo, !isSmartexIo, liveRevision, kind);
  const rangeOptions = useMemo(
    () =>
      availableTimeRanges(
        measurementRange,
        timeRangeCandidates({ long: true, staff: isStaff }),
      ),
    [isStaff, measurementRange],
  );
  const isLatest = selectedRange === LATEST_RANGE;
  const range: StatusRange = isLatest
    ? LATEST_RANGE
    : effectiveTimeRange(selectedRange, rangeOptions);
  return {
    measurementRange,
    measurementRangeFailed,
    rangeRevision,
    rangeOptions,
    isLatest,
    range,
    rangeDays: rangeDaysOf(range),
  };
};

type HistoryArgs = {
  locationId: number;
  demo: boolean;
  isSmartexIo: boolean;
  isLatest: boolean;
  rangeDays: number;
  measurementRange: MeasurementRange | null;
  measurementRangeFailed: boolean;
  openedAt: number;
  heatProfile: HeatProfile;
  pickedStep: number | null;
  rangeRevision: number;
  liveRevision: number;
  /** Only the leak devices of a location with climate sensors too. */
  kind?: DeviceKind;
};

/**
 * The histories loaded: the whole history for a period (the plan's frames
 * and the Zeitreihe are cut out of it, no request) - "Letzte Messung" needs
 * ten small frames (?latest=1) and reloads just those on new data - each
 * also in the picked heat profile (staff), only for the plan.
 */
const useHistorySources = (
  {
    locationId,
    demo,
    isSmartexIo,
    isLatest,
    heatProfile,
    rangeRevision,
    liveRevision,
    kind,
  }: HistoryArgs,
  historySpec: HeatmapWindow | null,
) => {
  const periodSpec = isLatest ? null : historySpec;
  const latestSpec = isLatest && !isSmartexIo ? 'latest' : null;
  const withProfile = heatProfile !== 'diff';
  const period = useLocationHistory(
    locationId,
    demo,
    periodSpec,
    'diff',
    rangeRevision,
    kind,
  );
  const periodProfile = useLocationHistory(
    locationId,
    demo,
    withProfile ? periodSpec : null,
    heatProfile,
    rangeRevision,
    kind,
  );
  const latest = useLocationHistory(
    locationId,
    demo,
    latestSpec,
    'diff',
    liveRevision,
    kind,
  );
  const latestProfile = useLocationHistory(
    locationId,
    demo,
    withProfile ? latestSpec : null,
    heatProfile,
    liveRevision,
    kind,
  );
  const profile = isLatest ? latestProfile : periodProfile;
  return {
    period,
    shown: isLatest ? latest : period,
    // While the picked profile loads, the heat keeps |WP - EP|.
    profileHistory: withProfile ? profile.history : null,
    profileLoading: withProfile && profile.loading,
  };
};

/**
 * The history the page shows (see useHistorySources) and what is cut out
 * of it for the range (the last N days up to when the history arrived):
 * the plan's frames in its step, the profile's frames and the Zeitreihe.
 */
export const useStatusHistory = (args: HistoryArgs) => {
  const {
    isSmartexIo,
    isLatest,
    rangeDays,
    measurementRange,
    measurementRangeFailed,
    openedAt,
    pickedStep,
  } = args;
  const historySpec = useMemo(
    () =>
      isSmartexIo
        ? null
        : historySpecFor(measurementRange, measurementRangeFailed, openedAt),
    [isSmartexIo, measurementRange, measurementRangeFailed, openedAt],
  );
  const { period, shown, profileHistory, profileLoading } = useHistorySources(
    args,
    historySpec,
  );

  // The step of the loaded history: the plan's steps must be multiples.
  const baseStep = period.history?.step ?? historySpec?.step ?? null;
  const stepOptions = useMemo(
    () => stepsForRange(rangeDays, baseStep),
    [rangeDays, baseStep],
  );
  const heatmapStep = heatmapStepOf(pickedStep, stepOptions, rangeDays, baseStep);

  const now = shown.loadedAt ?? openedAt;
  const frameWindow = useMemo(
    () => rangeWindow(now, rangeDays, heatmapStep),
    [now, rangeDays, heatmapStep],
  );
  const heatmap = useMemo(
    () => planFramesOf(shown.history, isLatest, frameWindow),
    [shown.history, isLatest, frameWindow],
  );
  const profileHeatmap = useMemo(
    () => planFramesOf(profileHistory, isLatest, frameWindow),
    [profileHistory, isLatest, frameWindow],
  );
  const zeitreihe = useMemo(
    () => zeitreiheOf(shown.history, isLatest, rangeWindow(now, rangeDays, 0), baseStep),
    [shown.history, isLatest, now, rangeDays, baseStep],
  );

  return {
    /** The history shown: the period's or the latest measurements'. */
    history: shown.history,
    loading: shown.loading,
    denied: shown.denied,
    now,
    stepOptions,
    heatmapStep,
    heatmap,
    profileHeatmap,
    profileLoading,
    zeitreihe,
  };
};
