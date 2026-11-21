import { useCallback, useMemo, useState } from 'react';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import usePermissions from '../../hooks/usePermissions';
import type { HeatProfile } from '../components/device/sensorHeatmapTypes';
import type { LocationDetail } from './locationTypes';
import { isLorawanProject } from './projectType';
import { staffFlags } from './access';
import {
  availableTimeRanges,
  effectiveTimeRange,
  TIME_RANGE_DAYS,
  timeRangeCandidates,
  type TimeRange,
} from './timeRanges';
import useMeasurementRange from './useMeasurementRange';

const DEFAULT_RESOLUTION = 300;

/**
 * What the Analyse page offers whom. LoRaWAN objects have no samples - a
 * humidity/temperature heatmap of the placed sensors and their charts
 * replace the heatmap and samples chart. Staff (and superusers): battery
 * charts and the Störungsprofile - their measurements are loaded raw
 * (?raw=1) and cleaned on the page; everyone else gets them cleaned by the
 * backend. Switching sensors off / on needs module_locations_edit.
 */
export const useAnalyseAccess = (location: LocationDetail | null) => {
  const auth = useAuth();
  const { hasPermission } = usePermissions();
  const isLorawan = isLorawanProject(location?.project_type);
  const isStaff = staffFlags(auth?.user).isStaffOrSuperuser;
  const offerNoiseProfiles = isStaff && !isLorawan;
  return {
    isLorawan,
    isStaff,
    canSwitchSensors: hasPermission('module_locations_edit') && !isLorawan,
    offerNoiseProfiles,
    rawQuery: offerNoiseProfiles ? '&raw=1' : '',
  };
};

/**
 * One period for the heatmap and the charts (also LoRaWAN's) - only periods
 * the data reaches into; an unavailable selection falls back to the longest
 * offered one. With it: how many measurements a period is loaded with, over
 * how many neighbouring ones every value is averaged (1: not - less noise)
 * and, for staff, the heatmap's value per sensor (|WP - EP|, WP, EP, WP + EP).
 */
export const useAnalysePeriod = (locationId: number, isStaff: boolean) => {
  const measurementRange = useMeasurementRange(locationId, false);
  const rangeOptions = useMemo(
    () =>
      availableTimeRanges(
        measurementRange,
        timeRangeCandidates({ staff: isStaff }),
      ),
    [isStaff, measurementRange],
  );
  const [selectedRange, setSelectedRange] = useState<TimeRange>('7d');
  const range = effectiveTimeRange(selectedRange, rangeOptions);
  const [resolution, setResolution] = useState<number>(DEFAULT_RESOLUTION);
  const [meanWindow, setMeanWindow] = useState(1);
  const [heatProfile, setHeatProfile] = useState<HeatProfile>('diff');
  return {
    measurementRange,
    rangeOptions,
    range,
    days: TIME_RANGE_DAYS[range],
    setSelectedRange,
    resolution,
    setResolution,
    meanWindow,
    setMeanWindow,
    heatProfile,
    setHeatProfile,
  };
};

/** A choice that holds for one location only - another one starts afresh. */
export const useLocationChoice = <T>(locationId: number) => {
  const [choice, setChoice] = useState<{
    locationId: unknown;
    value: T;
  } | null>(null);
  const set = useCallback(
    (value: T | null) =>
      setChoice(value != null ? { locationId, value } : null),
    [locationId],
  );
  return [
    choice && choice.locationId === locationId ? choice.value : null,
    set,
  ] as const;
};
