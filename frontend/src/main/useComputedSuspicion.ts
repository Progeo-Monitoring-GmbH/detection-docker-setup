import { useCallback, useEffect, useRef, useState } from 'react';
import { useSnackbar } from 'notistack';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig';
import { showRequestError } from '../components/ui/Snackbar.jsx';
import useAlarmAcknowledge from './useAlarmAcknowledge';
import {
  computedSuspicionUrl,
  type ComputedSuspicionPoint,
} from './computedSuspicion';
import { useLatestRef } from '../components/ui/useLatestRef';

/**
 * smartex® mx-PEEL: the computed suspicion points of a location over the
 * last `days` (the Status tab's range) - loaded while `enabled`, again when
 * the range changes or, quietly, when `revision` goes up (new data,
 * useLocationLiveRevision) - and acknowledging a point, i.e. every pending
 * alarm of its member sensors (then it reloads).
 */
export const useComputedSuspicion = (
  locationId: number,
  days: number,
  demo: boolean,
  enabled: boolean,
  revision = 0,
) => {
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const [points, setPoints] = useState<ComputedSuspicionPoint[]>([]);
  // The location and range the shown points belong to: loading until they match.
  const key = `${locationId}:${days}:${demo}`;
  const [answeredKey, setAnsweredKey] = useState<string | null>(null);
  const loading = enabled && answeredKey !== key;
  const [denied, setDenied] = useState(false);

  // `auth` changes with the path - no reason to ask again.
  const authRef = useLatestRef(auth);
  // Only the answer of the newest request counts (range switched meanwhile).
  const requestRef = useRef(0);

  const fetchPoints = useCallback(() => {
    const request = ++requestRef.current;
    const requestKey = `${locationId}:${days}:${demo}`;
    void axiosConfig.perform_get(
      authRef.current,
      computedSuspicionUrl(locationId, days, demo),
      (response) => {
        if (request !== requestRef.current) {
          return;
        }
        setPoints((response?.data?.points || []) as ComputedSuspicionPoint[]);
        setDenied(false);
        setAnsweredKey(requestKey);
      },
      (error) => {
        if (request !== requestRef.current) {
          return;
        }
        if (error?.response?.status === 403) {
          setDenied(true);
        } else {
          showRequestError(
            enqueueSnackbar,
            'Could not load the computed suspicion points',
            error,
          );
        }
        setAnsweredKey(requestKey);
      },
    );
  }, [days, demo, enqueueSnackbar, locationId, authRef]);

  useEffect(() => {
    if (enabled) {
      fetchPoints();
    }
  }, [enabled, fetchPoints, revision]);

  // Acknowledging every pending alarm of a point, then reloading.
  const { acknowledging, acknowledge } = useAlarmAcknowledge(locationId, fetchPoints);

  return {
    points,
    loading,
    denied,
    acknowledging,
    acknowledge,
    reload: fetchPoints,
  };
};
