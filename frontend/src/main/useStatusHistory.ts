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
import {
  type LiveMeasurements,
  useLocationLiveRevision,
} from './useLocationLiveRevision';
import { useMeasurementRangeState } from './useMeasurementRange';

/**
 * New data while the page is open (every controller sample, and whatever
 * came while the socket was down): the range, the history, the
 * Verdachtsstellen and the KPIs reload quietly on the returned revision,
 * the picked view, range and sensor stay - a toast tells new measurements.
 */
export const useStatusLiveRevision = (locationId: number, enabled: boolean) => {
  const { t } = useTranslation();
  const { enqueueSnackbar } = useSnackbar();
  const onLiveMeasurements = useCallback(
    (measurements: LiveMeasurements) => {
      const toast = liveMeasurementToast(measurements);
      const message = toast.options
        ? t(toast.key, toast.options)
        : t(toast.key);
      enqueueSnackbar(message, { variant: toast.variant });
    },
    [enqueueSnackbar, t],
  );
  return useLocationLiveRevision(locationId, enabled, onLiveMeasurements);
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
}: {
  locationId: number;
  demo: boolean;
  isSmartexIo: boolean;
  isStaff: boolean;
  selectedRange: StatusRange;
  liveRevision: number;
}) => {
  const {
    range: measurementRange,
    failed: measurementRangeFailed,
    // The history follows once the range of the new data is there (its
    // window ends at the newest measurement).
    revision: rangeRevision,
  } = useMeasurementRangeState(locationId, demo, !isSmartexIo, liveRevision);
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
  );
  const periodProfile = useLocationHistory(
    locationId,
    demo,
    withProfile ? periodSpec : null,
    heatProfile,
    rangeRevision,
  );
  const latest = useLocationHistory(
    locationId,
    demo,
    latestSpec,
    'diff',
    liveRevision,
  );
  const latestProfile = useLocationHistory(
    locationId,
    demo,
    withProfile ? latestSpec : null,
    heatProfile,
    liveRevision,
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
