import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig';
import type { MeasurementRange } from './timeRanges';

/**
 * Oldest/newest measurement of a location (GET .../measurement-range/),
 * fetched once per location - and again whenever `revision` goes up (new
 * data, useLocationLiveRevision), keeping the old range until the new one
 * is there. `range` is null while loading, on failure (`failed`, quietly -
 * the views then just offer the short ranges) or while `enabled` is false.
 * `revision` in the answer: the revision the shown range (or the failure)
 * belongs to.
 */
export const useMeasurementRangeState = (
  locationId: number,
  demo: boolean,
  enabled = true,
  revision = 0,
): { range: MeasurementRange | null; failed: boolean; revision: number } => {
  const auth = useAuth();
  const key = `${demo ? 'demo' : 'location'}:${locationId}`;
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
      `${demo ? '/v1/demo' : '/v1/location'}/${locationId}/measurement-range/`,
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
  }, [auth, demo, enabled, key, locationId, requestKey, revision]);

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

const useMeasurementRange = (locationId: number, demo: boolean, enabled = true): MeasurementRange | null =>
  useMeasurementRangeState(locationId, demo, enabled).range;

export default useMeasurementRange;
