import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig';
import type { MeasurementRange } from './timeRanges';

/**
 * Oldest/newest measurement of a location (GET .../measurement-range/),
 * fetched once per location. `range` is null while loading, on failure
 * (`failed`, quietly - the views then just offer the short ranges) or while
 * `enabled` is false.
 */
export const useMeasurementRangeState = (
  locationId: number,
  demo: boolean,
  enabled = true,
): { range: MeasurementRange | null; failed: boolean } => {
  const auth = useAuth();
  const key = `${demo ? 'demo' : 'location'}:${locationId}`;
  const [result, setResult] = useState<{
    key: string;
    range: MeasurementRange;
  } | null>(null);
  const requestedKey = useRef<string | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || requestedKey.current === key) {
      return;
    }
    requestedKey.current = key;
    void axiosConfig.perform_get(
      auth,
      `${demo ? '/v1/demo' : '/v1/location'}/${locationId}/measurement-range/`,
      (response) => {
        const data = response?.data;
        setResult({
          key,
          range: {
            first: data?.first ?? null,
            last: data?.last ?? null,
            count: Number(data?.count ?? 0),
          },
        });
      },
      () => {
        // No snackbar: without the range the views simply keep the short
        // ranges.
        setFailedKey(key);
      },
    );
  }, [auth, demo, enabled, key, locationId]);

  return { range: result?.key === key ? result.range : null, failed: failedKey === key };
};

const useMeasurementRange = (locationId: number, demo: boolean, enabled = true): MeasurementRange | null =>
  useMeasurementRangeState(locationId, demo, enabled).range;

export default useMeasurementRange;
