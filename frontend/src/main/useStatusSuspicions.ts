import { useMemo, useState } from 'react';
import {
  effectiveSuspicionMode,
  suspicionMarkersOf,
  type SuspicionMode,
} from './computedSuspicion';
import { openCountOf } from './locationStatusViewData';
import { useAlarmClusters } from './useAlarmClusters';
import { useComputedSuspicion } from './useComputedSuspicion';

/**
 * The status page's Verdachtsstellen: one per sensor (the alarm clusters -
 * also the KPIs' source) and the computed suspicion points of the range
 * instead (every product) - staff can switch (computedSuspicion.ts).
 * LoRaWAN climate objects have neither.
 */
export const useStatusSuspicions = ({
  locationId,
  demo,
  isLorawan,
  isStaff,
  rangeDays,
  liveRevision,
}: {
  locationId: number;
  demo: boolean;
  isLorawan: boolean;
  isStaff: boolean;
  rangeDays: number;
  liveRevision: number;
}) => {
  const alarmClusters = useAlarmClusters(
    locationId,
    demo,
    !isLorawan,
    liveRevision,
  );
  const [pickedMode, setSuspicionMode] = useState<SuspicionMode>('computed');
  const suspicionMode = effectiveSuspicionMode(isStaff, pickedMode);
  const isComputed = suspicionMode === 'computed';
  const computed = useComputedSuspicion(
    locationId,
    rangeDays,
    demo,
    isComputed && !isLorawan,
    liveRevision,
  );
  const suspicionMarkers = useMemo(
    () => (isComputed ? suspicionMarkersOf(computed.points) : undefined),
    [isComputed, computed.points],
  );
  // The open Verdachtsstellen as the panel shows them (the computed
  // points); null: one per sensor.
  const openSuspicions =
    isComputed && !computed.loading ? openCountOf(computed.points) : null;

  return {
    alarmClusters,
    computed,
    suspicionMode,
    setSuspicionMode,
    suspicionMarkers,
    openSuspicions,
  };
};
