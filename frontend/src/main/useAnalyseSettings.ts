import { useCallback, useMemo, useState } from 'react';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import usePermissions from '../../hooks/usePermissions';
import type { HeatProfile } from '../components/device/sensorHeatmapTypes';
import type { DeviceKind, LocationDetail } from './locationTypes';
import { deviceKindsOf, isSmartexIoProject } from './projectType';
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
 * What the Analyse page offers whom. smartex io objects have no samples - a
 * humidity/temperature heatmap of the placed sensors and their charts
 * replace the heatmap and samples chart. Staff (and superusers): battery
 * charts and the Störungsprofile - their measurements are loaded raw
 * (?raw=1) and cleaned on the page; everyone else gets them cleaned by the
 * backend. Switching sensors off / on needs module_locations_edit. `kinds`:
 * the device kinds of the location - with both, the page shows tabs.
 */
export const useAnalyseAccess = (location: LocationDetail | null) => {
  const auth = useAuth();
  const { hasPermission } = usePermissions();
  const isSmartexIo = isSmartexIoProject(location?.project_type);
  const isStaff = staffFlags(auth?.user).isStaffOrSuperuser;
  const offerNoiseProfiles = isStaff && !isSmartexIo;
  const kinds = useMemo(() => deviceKindsOf(location), [location]);
  return {
    isSmartexIo,
    isStaff,
    kinds,
    canSwitchSensors: hasPermission('module_locations_edit') && !isSmartexIo,
    offerNoiseProfiles,
    rawQuery: offerNoiseProfiles ? '&raw=1' : '',
  };
};

/**
 * One period for the heatmap and the charts (also smartex io) - only periods
 * the data reaches into; an unavailable selection falls back to the longest
 * offered one. With it: how many measurements a period is loaded with, over
 * how many neighbouring ones every value is averaged (1: not - less noise)
 * and, for staff, the heatmap's value per sensor (|WP - EP|, WP, EP, WP + EP).
 * `kind`: the tab shown in a location with both kinds - the periods follow
 * its devices' data (the leak tab offers none only climate data reaches).
 * Both kinds' ranges load at once: a switch must not reload the period.
 */
export const useAnalysePeriod = (locationId: number, isStaff: boolean, kind?: DeviceKind) => {
  const mixed = kind !== undefined;
  const leakRange = useMeasurementRange(locationId, false, true, mixed ? 'leak' : undefined);
  const climateRange = useMeasurementRange(locationId, false, mixed, 'climate');
  const measurementRange = kind === 'climate' ? climateRange : leakRange;
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
