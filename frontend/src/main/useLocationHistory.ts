import { useEffect, useRef, useState } from 'react';
import { useSnackbar } from 'notistack';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig';
import { heatmapQuery, type HeatmapWindow } from '../components/device/heatmapSteps';
import {
  type HeatProfile,
  heatProfileQuery,
  type SensorHeatmapResponse,
} from '../components/device/sensorHeatmapTypes';
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
 * refetched, except when `revision` goes up (new data,
 * useLocationLiveRevision): then it is loaded again, the old one shown until
 * the new one is there. Nothing is loaded while `spec` is null.
 */
export const useLocationHistory = (
  locationId: number,
  demo: boolean,
  /** The window - or 'latest': every device's newest measurement as one
   * frame (?latest=1, the status page's "Letzte Messung"). */
  spec: HeatmapWindow | 'latest' | null,
  /** The value per sensor (?profile=) - |WP - EP| by default. */
  profile: HeatProfile = 'diff',
  revision = 0,
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
    const query = spec === 'latest' ? 'latest=1' : heatmapQuery(spec);
    const url = `${demo ? '/v1/demo' : '/v1/location'}/${locationId}/heatmap/?${query}${heatProfileQuery(profile)}`;
    const request = `${url}#${revision}`;
    if (requested.current === request) {
      return;
    }
    requested.current = request;
    void axiosConfig.perform_get(
      auth,
      url,
      (response) => {
        if (requested.current !== request) {
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
        if (requested.current !== request) {
          return;
        }
        const denied = error?.response?.status === 403;
        if (!denied) {
          showRequestError(enqueueSnackbar, 'Could not load heatmap', error);
        }
        setState((prev) => ({ ...prev, loading: false, denied }));
      },
    );
  }, [auth, demo, enqueueSnackbar, locationId, profile, revision, spec]);

  return state;
};
