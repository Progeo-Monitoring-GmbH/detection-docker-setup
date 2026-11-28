import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig';
import type { DeviceKind } from './locationTypes';
import type { MeasurementRange } from './timeRanges';

/**
 * Oldest/newest measurement of a location (GET .../measurement-range/),
 * fetched once per location - and again whenever `revision` goes up (new
 * data, useLocationLiveRevision), keeping the old range until the new one
 * is there. `range` is null while loading, on failure (`failed`, quietly -
 * the views then just offer the short ranges) or while `enabled` is false.
 * `revision` in the answer: the revision the shown range (or the failure)
 * belongs to. `kind`: only the devices of that kind (a location with leak
 * devices and climate sensors, ?kind=) - without it all of them.
 */
export const useMeasurementRangeState = (
  locationId: number,
  demo: boolean,
  enabled = true,
  revision = 0,
  kind?: DeviceKind,
): { range: MeasurementRange | null; failed: boolean; revision: number } => {
  const auth = useAuth();
  const key = `${demo ? 'demo' : 'location'}:${locationId}:${kind ?? ''}`;
  const requestKey = `${key}#${revision}`;
  const [result, setResult] = useState<{
    key: string;
    range: MeasurementRange;
    revision: number;
  } | null>(null);
  const requestedKey = useRef<string | null>(null);
  const [failed, setFailed] = useState<{ key: string; revision: number } | null>(null);

  useEffect(() => {
    if (!enabled || requestedKey.current === requestKey) {
      return;
    }
    requestedKey.current = requestKey;
    void axiosConfig.perform_get(
      auth,
      `${demo ? '/v1/demo' : '/v1/location'}/${locationId}/measurement-range/${kind ? `?kind=${kind}` : ''}`,
      (response) => {
        if (requestedKey.current !== requestKey) {
          return;
        }
        const data = response?.data;
        setResult({
          key,
          revision,
          range: {
            first: data?.first ?? null,
            last: data?.last ?? null,
            count: Number(data?.count ?? 0),
            next: data?.next ?? null,
            offline_after: data?.offline_after ?? null,
          },
        });
        setFailed(null);
      },
      () => {
        if (requestedKey.current !== requestKey) {
          return;
        }
        // No snackbar: without the range the views simply keep the short
        // ranges (a failed reload keeps the range shown).
        setFailed({ key, revision });
      },
    );
  }, [auth, demo, enabled, key, kind, locationId, requestKey, revision]);

  const range = result?.key === key ? result.range : null;
  const failedHere = failed?.key === key;
  return {
    range,
    failed: failedHere && range === null,
    revision: Math.max(
      result?.key === key ? result.revision : 0,
      failedHere ? failed.revision : 0,
    ),
  };
};

const useMeasurementRange = (
  locationId: number,
  demo: boolean,
  enabled = true,
  kind?: DeviceKind,
): MeasurementRange | null => useMeasurementRangeState(locationId, demo, enabled, 0, kind).range;

export default useMeasurementRange;
