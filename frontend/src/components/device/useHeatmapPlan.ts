import { useMemo, useState } from 'react';
import { planLocation } from './heatmapChart';
import { useHeatSigma } from './useHeatSigma';
import { useLageplanImageState } from './useLageplanImage';
import { getBackendUrl } from '../../backendUrl';
import { useAuth } from '../../../hooks/CoreAuthProvider';
import { staffFlags } from '../../main/access';
import type {
  SensorHeatmapLageplanData,
  SensorHeatmapLocation,
  SensorHeatmapResponse,
} from './sensorHeatmapTypes';

/** The picked Lageplan of `plans`, for the plans it was picked from - new
 * plans start with the first. */
const usePlanChoice = <T>(plans: T[] | null) => {
  const [choice, setChoice] = useState<{
    plans: T[] | null;
    index: number;
  } | null>(null);
  const index =
    plans && choice?.plans === plans
      ? Math.min(choice.index, plans.length - 1)
      : 0;
  const choose = (next: number) => setChoice({ plans, index: next });
  return [index, choose] as const;
};

/** The index of the plan with this id - the first for none / an unknown one. */
export const planIndexOf = (
  plans: Array<{ id?: number }> | null,
  planId: number | null,
) => Math.max(plans?.findIndex((plan) => plan.id === planId) ?? 0, 0);

/**
 * The Lageplan SensorHeatmap2D shows, of the location's plans (there may be
 * several to swap between) - the alignment (the wizard's sliders) takes
 * precedence over the response's location. With `onPlanChange` the parent
 * keeps the pick (`planId`), else it is kept here - and shows the switcher:
 * `switchablePlans` (those of the own switcher) is null then, and so in the
 * alignment wizard. `location` is the location merged with the shown plan
 * (planLocation); `image` its plan image, `imagePending` while it loads.
 */
export const useHeatmapPlan = ({
  response,
  alignment,
  planId,
  onPlanChange,
}: {
  response: SensorHeatmapResponse | null | undefined;
  alignment: SensorHeatmapLocation | null;
  planId: number | null;
  onPlanChange: ((planId: number) => void) | undefined;
}) => {
  const baseLocation = alignment ?? response?.location ?? null;
  const plans = useMemo(() => {
    const list = baseLocation?.lageplans;
    return Array.isArray(list) && list.length > 0 ? list : null;
  }, [baseLocation]);
  const [ownPlanIndex, chooseOwnPlan] = usePlanChoice(plans);
  const planIndex = onPlanChange ? planIndexOf(plans, planId) : ownPlanIndex;
  const choosePlan = (index: number) => {
    const picked = plans?.[index]?.id;
    if (!onPlanChange) {
      chooseOwnPlan(index);
    } else if (picked != null) {
      onPlanChange(picked);
    }
  };
  const activePlan = plans?.[planIndex] ?? null;
  const location = useMemo(
    () => planLocation(baseLocation, activePlan),
    [baseLocation, activePlan],
  );
  // A plan image still loading: the plot keeps its height (no layout
  // without the image first, then with it).
  const { image, pending: imagePending } = useLageplanImageState(
    location?.lageplan_url ? getBackendUrl(location.lageplan_url) : null,
  );
  const switchablePlans = alignment || onPlanChange ? null : plans;
  return {
    switchablePlans,
    planIndex,
    choosePlan,
    activePlan,
    location,
    image,
    imagePending,
  };
};

/**
 * Staff and superusers: the heat options (normalizing, the profile) and the
 * plan's kernel width σ (null: Auto σ), which they change and store - not in
 * the alignment wizard (`alignment`). `sigmaControl`: the σ controls' value
 * and change, undefined where σ isn't editable.
 */
export const useStaffHeatSettings = ({
  activePlan,
  alignment,
}: {
  activePlan: SensorHeatmapLageplanData | null;
  alignment: SensorHeatmapLocation | null;
}) => {
  const auth = useAuth();
  const staff = staffFlags(auth?.user).isStaffOrSuperuser;
  const canEditSigma = staff && !alignment;
  const [sigma, setSigma] = useHeatSigma({
    plan: activePlan,
    editable: canEditSigma,
  });
  return {
    staff,
    sigma,
    sigmaControl: canEditSigma
      ? { value: sigma, onChange: setSigma }
      : undefined,
  };
};
