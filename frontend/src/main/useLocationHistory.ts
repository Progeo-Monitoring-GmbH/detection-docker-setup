import { useEffect, useRef, useState } from 'react';
import { useSnackbar } from 'notistack';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig';
import { heatmapQuery, type HeatmapWindow } from '../components/device/heatmapSteps';
import type { SensorHeatmapResponse } from '../components/device/sensorHeatmapTypes';
import { showRequestError } from '../components/ui/Snackbar.jsx';

type LocationHistory = {
  history: SensorHeatmapResponse | null;
  /** When the history arrived - the "now" the views' windows end at. */
  loadedAt: number | null;
  loading: boolean;
  /** No permission to see the location's measurements. */
  denied: boolean;
};

/**
 * The location's whole history in a fine base step (`spec`, see
 * historyWindow), loaded once: every window and step of the plan, and the
 * Zeitreihe, are cut out of it in the browser (heatmapData.ts) - nothing is
 * refetched. Nothing is loaded while `spec` is null.
 */
export const useLocationHistory = (
  locationId: number,
  demo: boolean,
  spec: HeatmapWindow | null,
): LocationHistory => {
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const requested = useRef<string | null>(null);
  const [state, setState] = useState<LocationHistory>({
    history: null,
    loadedAt: null,
    loading: true,
    denied: false,
  });

  useEffect(() => {
    if (!spec) {
      return;
    }
    const url = `${demo ? '/v1/demo' : '/v1/location'}/${locationId}/heatmap/?${heatmapQuery(spec)}`;
    if (requested.current === url) {
      return;
    }
    requested.current = url;
    void axiosConfig.perform_get(
      auth,
      url,
      (response) => {
        if (requested.current !== url) {
          return;
        }
        setState({
          history: (response?.data || null) as SensorHeatmapResponse | null,
          loadedAt: Date.now(),
          loading: false,
          denied: false,
        });
      },
      (error) => {
        if (requested.current !== url) {
          return;
        }
        const denied = error?.response?.status === 403;
        if (!denied) {
          showRequestError(enqueueSnackbar, 'Could not load heatmap', error);
        }
        setState((prev) => ({ ...prev, loading: false, denied }));
      },
    );
  }, [auth, demo, enqueueSnackbar, locationId, spec]);

  return state;
};
