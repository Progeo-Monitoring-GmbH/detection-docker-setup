import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSnackbar } from 'notistack';
import { useAuth } from '../../../hooks/CoreAuthProvider';
import axiosConfig from '../../axiosConfig';
import { showRequestError } from '../ui/Snackbar.jsx';
import type { SensorHeatmapLageplanData } from './sensorHeatmapTypes';

export type HeatSigma = 'auto' | number;

/** How long a σ change rests before it is stored - the slider sends many. */
const SAVE_DELAY_MS = 600;

/**
 * σ stored in this session, by plan id: a heatmap response from a cache
 * (the Analyse page keeps them) still carries the plan's old heat_sigma.
 */
const savedSigmas = new Map<number, number | null>();

/**
 * The heatmap's kernel width (σ) of a Lageplan: ProgeoLageplan.heat_sigma,
 * null = "Auto σ" (computeAutoSigma). `editable` (staff): a change is shown
 * at once and stored for the plan (POST /v1/location/<id>/heat-sigma/), so
 * everyone's heatmap of the plan uses it. Without a plan the change stays
 * local.
 */
export const useHeatSigma = ({
  plan,
  editable,
}: {
  plan: SensorHeatmapLageplanData | null;
  editable: boolean;
}) => {
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const { t } = useTranslation();
  const planId = plan?.id ?? null;
  const locationId = plan?.location_id ?? null;
  // The value picked here - for the plan it was picked on.
  const [picked, setPicked] = useState<{ planId: number | null; sigma: HeatSigma } | null>(null);
  const stored = planId != null && savedSigmas.has(planId) ? savedSigmas.get(planId) : plan?.heat_sigma;
  const sigma: HeatSigma = picked && picked.planId === planId ? picked.sigma : (stored ?? 'auto');

  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const setSigma = (next: HeatSigma) => {
    setPicked({ planId, sigma: next });
    if (!editable || planId == null || locationId == null) {
      return;
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void axiosConfig.perform_post(
        auth,
        `/v1/location/${locationId}/heat-sigma/`,
        { lageplan_id: planId, sigma: next === 'auto' ? null : next },
        (response: { data?: { heat_sigma?: number | null } }) => {
          savedSigmas.set(planId, response?.data?.heat_sigma ?? null);
        },
        (error: unknown) => showRequestError(enqueueSnackbar, t('heatmap_sigma_save_failed'), error),
      );
    }, SAVE_DELAY_MS);
  };

  return [sigma, setSigma] as const;
};
