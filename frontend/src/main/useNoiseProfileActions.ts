import { type Dispatch, type SetStateAction, useState } from 'react';
import { useSnackbar } from 'notistack';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig';
import { showRequestError } from '../components/ui/Snackbar.jsx';
import { downloadBlob } from '../download';
import type { ProfileRange } from './NoiseProfilePanel';
import { type NoiseProfile, noiseProfileCsv, spanParts } from './noiseProfiles';
import type { NoiseProfileState } from './useNoiseProfileState';

type NoiseProfileActionsOptions = {
  locationId: number;
  /** For the CSV's file name; else the location id. */
  projectId: string | number | null | undefined;
  noise: NoiseProfileState;
  shownDevice: number | null;
  /** The span a new profile is made from (S + drag). */
  profileRange: ProfileRange | null;
  /** A profile changed: the heatmap (cleaned by the backend) reloads. */
  onChanged: () => void;
  setSelectedProfileId: Dispatch<SetStateAction<number | null>>;
};

/**
 * Staff: what the Störungsprofil panel does - a draft from a span, editing,
 * saving, activating, deactivating, deleting and downloading profiles.
 */
const useNoiseProfileActions = ({
  locationId,
  projectId,
  noise,
  shownDevice,
  profileRange,
  onChanged,
  setSelectedProfileId,
}: NoiseProfileActionsOptions) => {
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const { t } = useTranslation();
  const [noiseBusy, setNoiseBusy] = useState(false);
  const { draft, setDraft, setDraftPreview, setTestedProfileId } = noise;
  const failed = (error: unknown) => {
    setNoiseBusy(false);
    showRequestError(enqueueSnackbar, t('noise_profile_error'), error);
  };
  const succeeded = (message: string) =>
    enqueueSnackbar(message, { variant: 'success' });

  /** POST noise-profiles/<path>/ - then the profiles and the heatmap load again. */
  const noiseRequest = (
    path: string,
    data: object,
    done?: (response: { data?: { profile?: NoiseProfile } }) => void,
  ) => {
    setNoiseBusy(true);
    void axiosConfig.perform_post(
      auth,
      `/v1/location/${locationId}/noise-profiles/${path}/`,
      data,
      (response) => {
        setNoiseBusy(false);
        onChanged();
        noise.loadNoiseProfiles();
        done?.(response);
      },
      failed,
    );
  };

  // A new draft: per sensor the minimum EP / WP of every measurement (not
  // only the loaded ones) of the selected span.
  const createNoiseProfile = (span: ProfileRange | null = profileRange) => {
    if (shownDevice == null || !span) {
      return;
    }
    const iso = (ms: number) => encodeURIComponent(new Date(ms).toISOString());
    setNoiseBusy(true);
    void axiosConfig.perform_get(
      auth,
      `/v1/location/${locationId}/noise-profiles/suggest/?device=${shownDevice}&from=${iso(span.from)}&to=${iso(span.to)}`,
      (response) => {
        setNoiseBusy(false);
        const data = response?.data ?? {};
        setDraft({
          id: null,
          device: shownDevice,
          // With the span it was made from: "Profil 06.11.2026 · 7 Tage, 5 Std."
          name: t('noise_profile_default_name', {
            date: new Date().toLocaleDateString(),
            span: spanParts(span.to - span.from)
              .map(({ unit, count }) => t(`span_${unit}`, { count }))
              .join(', '),
          }),
          mask_e: (data.mask_e || []) as number[],
          mask_w: (data.mask_w || []) as number[],
          source_from: data.source_from ?? null,
          source_to: data.source_to ?? null,
          source_count: Number(data.source_count ?? 0),
        });
        setDraftPreview(true);
      },
      failed,
    );
  };

  const editNoiseProfile = (profile: NoiseProfile) => {
    setDraft({
      id: profile.id,
      device: profile.device,
      name: profile.name,
      mask_e: [...profile.mask_e],
      mask_w: [...profile.mask_w],
      source_from: profile.source_from,
      source_to: profile.source_to,
      source_count: profile.source_count,
    });
    setDraftPreview(true);
  };

  const saveNoiseProfile = () => {
    if (!draft) {
      return;
    }
    noiseRequest('save', { ...draft, name: draft.name.trim() }, (response) => {
      setDraft(null);
      setSelectedProfileId(response?.data?.profile?.id ?? null);
      succeeded(t('noise_profile_saved'));
    });
  };

  const activateNoiseProfile = (profile: NoiseProfile) =>
    noiseRequest('activate', { id: profile.id }, () => {
      setTestedProfileId(null);
      succeeded(t('noise_profile_activated', { name: profile.name }));
    });

  const deactivateNoiseProfile = () =>
    noiseRequest('deactivate', { device: shownDevice }, () =>
      succeeded(t('noise_profile_deactivated')),
    );

  const deleteNoiseProfile = (profile: NoiseProfile) =>
    noiseRequest('delete', { id: profile.id }, () => {
      setSelectedProfileId((id) => (id === profile.id ? null : id));
      setTestedProfileId((id) => (id === profile.id ? null : id));
    });

  const downloadNoiseProfile = (profile: NoiseProfile) =>
    downloadBlob(
      new Blob([noiseProfileCsv(profile)], { type: 'text/csv' }),
      `${projectId ?? locationId}-stoerungsprofil-${profile.id}.csv`,
    );

  return {
    noiseBusy,
    createNoiseProfile,
    editNoiseProfile,
    saveNoiseProfile,
    activateNoiseProfile,
    deactivateNoiseProfile,
    deleteNoiseProfile,
    downloadNoiseProfile,
  };
};

export default useNoiseProfileActions;
