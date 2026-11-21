import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSnackbar } from 'notistack';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig';
import { showRequestError } from '../components/ui/Snackbar.jsx';
import type { MixerSensor, PointPayload } from './thresholdMixer';
import { DEFAULT_PERIOD, patchedSensors, prunedPatch, type SavedPatch, withSavedPoints } from './thresholdMixerView';

/**
 * The mixer's sensors: the page's `loaded` ones (with what was just saved
 * patched in until the page's data has it), else GET measurepoints with the
 * maxima of the picked period (`days`).
 */
const useThresholdMixerData = (locationId: number | string, loadedSensors: MixerSensor[] | null) => {
  const auth = useAuth();
  const { t } = useTranslation();
  const { enqueueSnackbar } = useSnackbar();
  // Only without the page's data the panel loads its own.
  const fetchOwn = loadedSensors == null;

  const [days, setDays] = useState(DEFAULT_PERIOD);
  const [fetched, setFetched] = useState<MixerSensor[]>([]);
  const [loading, setLoading] = useState(fetchOwn);
  const [savedPatch, setSavedPatch] = useState<SavedPatch>({});
  const sensors = useMemo(
    () => (loadedSensors ? patchedSensors(loadedSensors, savedPatch) : fetched),
    [loadedSensors, savedPatch, fetched],
  );
  useEffect(() => {
    // The page reloaded its data: what it has now needs no patch any more.
    if (loadedSensors) {
      setSavedPatch((patch) => prunedPatch(patch, loadedSensors));
    }
  }, [loadedSensors]);

  const requestRef = useRef(0);
  const load = useCallback(
    (period: number) => {
      // Loading starts where the period or the data change (initially true).
      const request = ++requestRef.current;
      void axiosConfig.perform_get(
        auth,
        `/v1/location/${locationId}/measurepoints/?days=${period}`,
        (response) => {
          if (request !== requestRef.current) {
            return;
          }
          setFetched(((response?.data?.sensors || []) as MixerSensor[]).map((sensor) => ({
            ...sensor,
            max: sensor.max ?? null,
          })));
          setLoading(false);
        },
        (error) => {
          if (request === requestRef.current) {
            showRequestError(enqueueSnackbar, t('einstell_mixer_load_failed'), error);
            setLoading(false);
          }
        },
      );
    },
    [auth, enqueueSnackbar, locationId, t],
  );

  useEffect(() => {
    if (fetchOwn) {
      load(days);
    }
  }, [load, days, fetchOwn]);

  const pickPeriod = (period: number) => {
    setLoading(true);
    setDays(period);
  };

  /** After a save: keep the saved points until the page's data has them - or reload. */
  const afterSave = (points: PointPayload[]) => {
    if (fetchOwn) {
      setLoading(true);
      load(days);
    } else {
      setSavedPatch((patch) => withSavedPoints(patch, points));
    }
  };

  return { sensors, days, loading, pickPeriod, afterSave };
};

export default useThresholdMixerData;
