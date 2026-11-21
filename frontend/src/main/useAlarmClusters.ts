import { useCallback, useEffect, useRef, useState } from 'react';
import { useSnackbar } from 'notistack';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig';
import { showRequestError } from '../components/ui/Snackbar.jsx';
import useAlarmAcknowledge from './useAlarmAcknowledge';
import type { VerdachtsstelleCluster } from './locationStatusData';

const ALARM_WINDOW_DAYS = 90;

/**
 * The Verdachtsstellen of a location (the alarm clusters of the last
 * ALARM_WINDOW_DAYS), loaded once while `enabled` - again, quietly, when
 * `revision` goes up (new data, useLocationLiveRevision) - and acknowledging
 * them, which reloads them.
 */
export const useAlarmClusters = (
  locationId: number,
  demo: boolean,
  enabled: boolean,
  revision = 0,
) => {
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const [clusters, setClusters] = useState<VerdachtsstelleCluster[]>([]);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  /** When the clusters arrived - active alarms run until then. */
  const [loadedAt, setLoadedAt] = useState<number | null>(null);

  // Once per location (`auth` changes with the path, no reason to ask again).
  const authRef = useRef(auth);
  useEffect(() => {
    authRef.current = auth;
  }, [auth]);

  const fetchClusters = useCallback(() => {
    void axiosConfig.perform_get(
      authRef.current,
      demo
        ? `/v1/demo/alarm-clusters/?location=${locationId}&days=${ALARM_WINDOW_DAYS}`
        : `/v1/alarm/clusters/?location=${locationId}&days=${ALARM_WINDOW_DAYS}`,
      (response) => {
        setClusters((response?.data?.clusters || []) as VerdachtsstelleCluster[]);
        setDenied(false);
        setLoadedAt(Date.now());
        setLoading(false);
      },
      (error) => {
        if (error?.response?.status === 403) {
          setDenied(true);
        } else {
          showRequestError(enqueueSnackbar, 'Could not load suspected leaks', error);
        }
        setLoading(false);
      },
    );
  }, [demo, enqueueSnackbar, locationId]);

  useEffect(() => {
    if (enabled) {
      fetchClusters();
    }
  }, [enabled, fetchClusters, revision]);

  // Acknowledging every pending alarm of a cluster, then reloading.
  const { acknowledging, acknowledge } = useAlarmAcknowledge(locationId, () => {
    setLoading(true);
    fetchClusters();
  });

  return { clusters, loading, denied, loadedAt, acknowledging, acknowledge };
};
