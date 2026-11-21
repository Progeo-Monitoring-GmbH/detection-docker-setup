import { useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { planFromParams } from './planParam';
import { getBackendUrl } from '../backendUrl';
import { usePreloadLageplanImages } from '../components/device/useLageplanImage';
import SegmentedControl from '../components/ui/kit/SegmentedControl';
import type { LocationDetail } from './locationTypes';

type Plan = { id: number; name?: string | null; url?: string | null };

/** The plan shown: the picked one (of this location), else ?plan=, else the first. */
export const shownPlanId = (
  plans: readonly Plan[],
  picked: { locationId: unknown; id: number } | null,
  locationId: unknown,
  urlPlan: number | null,
): number | null => {
  if (
    picked &&
    picked.locationId === locationId &&
    plans.some((plan) => plan.id === picked.id)
  ) {
    return picked.id;
  }
  if (plans.some((plan) => plan.id === urlPlan)) {
    return urlPlan;
  }
  return plans[0]?.id ?? null;
};

/**
 * The Lageplan the heatmap shows - only its sensors are loaded (?lageplan=).
 * Picked in the heatmap's switcher or with the keys 1-9; ?plan= (a merged
 * project's group bar, planParam.ts); else the first (the main plan).
 * Every plan's image loads in the background - switching then draws at once.
 */
export const useAnalysePlans = (
  location: LocationDetail | null,
  locationId: number,
) => {
  const plans = useMemo(
    () =>
      (location?.lageplans ?? []).filter(
        (plan): plan is typeof plan & { id: number } => plan.id != null,
      ),
    [location?.lageplans],
  );
  usePreloadLageplanImages(
    useMemo(
      () =>
        plans.flatMap((plan) => (plan.url ? [getBackendUrl(plan.url)] : [])),
      [plans],
    ),
  );
  const [pickedPlan, setPickedPlan] = useState<{
    locationId: unknown;
    id: number;
  } | null>(null);
  const [searchParams] = useSearchParams();
  const planId = shownPlanId(
    plans,
    pickedPlan,
    locationId,
    planFromParams(searchParams),
  );
  const pickPlan = useCallback(
    (id: number) => setPickedPlan({ locationId, id }),
    [locationId],
  );
  return {
    plans,
    planId,
    pickPlan,
    planQuery: planId != null ? `&lageplan=${planId}` : '',
  };
};

/**
 * The plan switcher of /status (LocationPlanPanel) - each pill shows its
 * key (1-9) while `hotkeys`; first in the heatmap's toolbar row. Nothing
 * for a single plan.
 */
const AnalysePlanSwitcher = ({
  plans,
  planId,
  hotkeys,
  onPick,
}: {
  plans: readonly Plan[];
  planId: number | null;
  hotkeys: boolean;
  onPick: (id: number) => void;
}) => {
  const { t } = useTranslation();
  if (plans.length <= 1) {
    return null;
  }
  return (
    <SegmentedControl
      options={plans.map((plan, index) => {
        const keyed = hotkeys && index < 9;
        return {
          value: String(plan.id),
          label: plan.name || t('status_plan_view', { index: index + 1 }),
          hotkey: keyed ? String(index + 1) : undefined,
          title: keyed ? t('analyse_plan_key', { key: index + 1 }) : undefined,
        };
      })}
      value={String(planId)}
      onChange={(value) => onPick(Number(value))}
      testId="analyse-heatmap-plans"
    />
  );
};

/** The plan switcher for the heatmap's toolbar - null for a single plan
 * (the toolbar then has no row for it). */
export const planSwitcherOf = (
  plans: readonly Plan[],
  planId: number | null,
  hotkeys: boolean,
  onPick: (id: number) => void,
) =>
  plans.length > 1 ? (
    <AnalysePlanSwitcher
      plans={plans}
      planId={planId}
      hotkeys={hotkeys}
      onPick={onPick}
    />
  ) : null;
