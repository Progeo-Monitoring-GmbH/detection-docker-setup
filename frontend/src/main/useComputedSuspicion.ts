import { useCallback, useEffect, useRef, useState } from 'react';
import { useSnackbar } from 'notistack';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig';
import { showRequestError } from '../components/ui/Snackbar.jsx';
import {
  computedSuspicionUrl,
  type ComputedSuspicionPoint,
} from './computedSuspicion';

/**
 * smartex® mx-PEEL: the computed suspicion points of a location over the
 * last `days` (the Status tab's range) - loaded while `enabled`, again when
 * the range changes - and acknowledging a point, i.e. every pending alarm
 * of its member sensors (then it reloads).
 */
export const useComputedSuspicion = (
  locationId: number,
  days: number,
  demo: boolean,
  enabled: boolean,
) => {
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const [points, setPoints] = useState<ComputedSuspicionPoint[]>([]);
  // The location and range the shown points belong to: loading until they match.
  const key = `${locationId}:${days}:${demo}`;
  const [answeredKey, setAnsweredKey] = useState<string | null>(null);
  const loading = enabled && answeredKey !== key;
  const [denied, setDenied] = useState(false);
  const [acknowledging, setAcknowledging] = useState<Set<string>>(new Set());

  // `auth` changes with the path - no reason to ask again.
  const authRef = useRef(auth);
  useEffect(() => {
    authRef.current = auth;
  }, [auth]);
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
  }, [days, demo, enqueueSnackbar, locationId]);

  useEffect(() => {
    if (enabled) {
      fetchPoints();
    }
  }, [enabled, fetchPoints]);

  /** Acknowledges every pending alarm of the point's sensors, then reloads. */
  const acknowledge = (point: ComputedSuspicionPoint) => {
    if (point.pending_ack_alarm_ids.length === 0) {
      return;
    }
    setAcknowledging((prev) => new Set(prev).add(point.id));
    Promise.all(
      point.pending_ack_alarm_ids.map(
        (alarmId) =>
          new Promise<void>((resolve) => {
            void axiosConfig.perform_post(
              auth,
              // ?location=: alarm ids are only unique within one project database.
              `/v1/alarm/${alarmId}/acknowledge/?location=${locationId}`,
              {},
              () => resolve(),
              (error) => {
                showRequestError(
                  enqueueSnackbar,
                  'Could not acknowledge alarm',
                  error,
                );
                resolve();
              },
            );
          }),
      ),
    ).then(() => {
      setAcknowledging((prev) => {
        const next = new Set(prev);
        next.delete(point.id);
        return next;
      });
      fetchPoints();
    });
  };

  return {
    points,
    loading,
    denied,
    acknowledging,
    acknowledge,
    reload: fetchPoints,
  };
};
