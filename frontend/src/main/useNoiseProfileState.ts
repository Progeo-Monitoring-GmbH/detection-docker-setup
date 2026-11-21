import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSnackbar } from 'notistack';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig';
import { showRequestError } from '../components/ui/Snackbar.jsx';
import type { NoiseProfile, NoiseProfileDraft } from './noiseProfiles';
import {
  deviceProfilesOf,
  displayMaskOf,
  heatNoiseQueryOf,
  maskLinesOf,
  noiseViewOf,
  shownProfilesOf,
} from './analyseNoiseView';

/**
 * Staff: the Störungsprofile of the location's devices (noiseProfiles.ts)
 * and what the shown values are cleaned with (analyseNoiseView.ts) - the
 * active profile, the one tried out ("Anwenden") or the draft being edited.
 * Only while `offer` (staff, not LoRaWAN).
 */
const useNoiseProfileState = ({
  locationId,
  offer,
  shownDevice,
}: {
  locationId: number;
  offer: boolean;
  shownDevice: number | null;
}) => {
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const { t } = useTranslation();
  const [load, setLoad] = useState<{
    locationId: unknown;
    profiles: NoiseProfile[];
  } | null>(null);
  const [testedProfileId, setTestedProfileId] = useState<number | null>(null);
  const [draft, setDraft] = useState<NoiseProfileDraft | null>(null);
  const [draftPreview, setDraftPreview] = useState(true);

  const loadNoiseProfiles = useCallback(() => {
    if (!offer) {
      return;
    }
    const forLocation = locationId;
    void axiosConfig.perform_get(
      auth,
      `/v1/location/${locationId}/noise-profiles/`,
      (response) =>
        setLoad({
          locationId: forLocation,
          profiles: (response?.data?.profiles || []) as NoiseProfile[],
        }),
      (error) =>
        showRequestError(enqueueSnackbar, t('noise_profile_error'), error),
    );
  }, [auth, enqueueSnackbar, locationId, offer, t]);

  useEffect(() => {
    loadNoiseProfiles();
  }, [loadNoiseProfiles]);

  // Those of the shown device - a profile belongs to one device.
  const deviceProfiles = useMemo(
    () => deviceProfilesOf(load, locationId, shownDevice),
    [load, locationId, shownDevice],
  );
  const { activeProfile, testedProfile, shownDraft } = shownProfilesOf(
    deviceProfiles,
    testedProfileId,
    draft,
    shownDevice,
  );
  const profiles = { shownDraft, draftPreview, testedProfile, activeProfile };
  const noiseView = noiseViewOf(profiles);
  // The mask the measurements are cleaned with here (staff load them raw).
  const displayMask = useMemo(
    () =>
      displayMaskOf(offer, noiseView, {
        shownDraft,
        draftPreview,
        testedProfile,
        activeProfile,
      }),
    [offer, noiseView, shownDraft, draftPreview, testedProfile, activeProfile],
  );
  const maskLines = useMemo(
    () => maskLinesOf(offer, noiseView, shownDraft),
    [offer, noiseView, shownDraft],
  );

  return {
    deviceProfiles,
    activeProfile,
    testedProfile,
    setTestedProfileId,
    draft,
    setDraft,
    shownDraft,
    draftPreview,
    setDraftPreview,
    noiseView,
    displayMask,
    maskLines,
    heatNoiseQuery: heatNoiseQueryOf(offer, noiseView, testedProfile),
    loadNoiseProfiles,
  };
};

export type NoiseProfileState = ReturnType<typeof useNoiseProfileState>;

export default useNoiseProfileState;
