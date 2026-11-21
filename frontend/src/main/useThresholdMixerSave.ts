import { type Dispatch, type SetStateAction, useState } from 'react';
import { useSnackbar } from 'notistack';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig';
import { showRequestError, showSuccessBar } from '../components/ui/Snackbar.jsx';
import {
  NO_DRAFTS,
  type PointPayload,
  savePayloadOf,
  type ThresholdChange,
  type ThresholdDrafts,
  withoutChange,
} from './thresholdMixer';

const OBJECT_CHANGE: ThresholdChange = { key: 'object', kind: 'object', from: null, to: null };

/** A callback-style request as a promise. */
const request = (send: (done: () => void, failed: (error: unknown) => void) => void) =>
  new Promise<void>((resolve, reject) => send(resolve, reject));

/**
 * Saves the pending `changes`: PATCH of the object's threshold (if it
 * changed), then POST of the sensors' thresholds / states. The drafts go,
 * `afterSave` gets the saved points (reload or keep them), `onSaved` follows.
 * If only the object got saved, its draft goes - the rest stays to retry.
 */
const useThresholdMixerSave = ({
  locationId,
  changes,
  setDrafts,
  setSavedObject,
  afterSave,
  onSaved,
}: {
  locationId: number | string;
  changes: ThresholdChange[];
  setDrafts: Dispatch<SetStateAction<ThresholdDrafts>>;
  setSavedObject: (value: number | null) => void;
  afterSave: (points: PointPayload[]) => void;
  onSaved?: () => void;
}) => {
  const auth = useAuth();
  const { t } = useTranslation();
  const { enqueueSnackbar } = useSnackbar();
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const payload = savePayloadOf(changes);
    setSaving(true);
    let objectSaved = false;
    try {
      if (payload.object) {
        const object = payload.object;
        await request((done, failed) =>
          axiosConfig.perform_patch(auth, `/v1/location/${locationId}/`, object, done, failed),
        );
        objectSaved = true;
        setSavedObject(object.alarm_threshold);
      }
      if (payload.points.length) {
        await request((done, failed) =>
          axiosConfig.perform_post(
            auth,
            `/v1/location/${locationId}/measurepoints/`,
            { points: payload.points },
            done,
            failed,
          ),
        );
      }
      showSuccessBar(enqueueSnackbar, t('einstell_mixer_saved', { count: changes.length }));
      setDrafts(NO_DRAFTS);
      afterSave(payload.points);
      onSaved?.();
    } catch (error) {
      showRequestError(enqueueSnackbar, t('einstell_mixer_save_failed'), error as never);
      // A saved object threshold is no draft any more.
      if (objectSaved) {
        setDrafts((prev) => withoutChange(prev, OBJECT_CHANGE));
      }
    } finally {
      setSaving(false);
    }
  };

  return { saving, save };
};

export default useThresholdMixerSave;
