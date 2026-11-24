import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useSnackbar } from 'notistack';
import { useAuth } from '../../hooks/CoreAuthProvider';
import usePermissions from '../../hooks/usePermissions';
import axiosConfig from '../axiosConfig';
import {
  showRequestError,
  showSuccessBar,
} from '../components/ui/Snackbar.jsx';
import ConfirmDialog from '../components/ui/kit/ConfirmDialog';
import type { LocationDetail } from './locationTypes';
import { PLAN_PARAM, planFromParams } from './planParam';
import './LocationSelection.css';
import { locationPagePath } from './portalNav';

type GroupPlan = { id: number; name?: string | null };
type GroupPart = {
  id: number;
  name: string | null;
  project_id: number | null;
  lageplans: GroupPlan[];
};
/** GET /v1/location-selection/group/ (backend helper/location_merge.py group_of). */
export type LocationGroup = {
  parent: { id: number; name: string | null; project_id: number | null };
  parts: GroupPart[];
};

/** The tabs that show a plan: the merged project itself opens its first part there. */
const PLAN_SEGMENTS = new Set(['status', 'analysis']);

/** "status" of /project/4711/status (or /location/12/status). */
export const portalSegment = (pathname: string) =>
  /^\/(?:project|location)\/[^/]+\/([^/?#]+)/.exec(pathname)?.[1] ?? 'status';

/** One pill per plan of every part (a part without plans: one pill for the part). */
export const groupPills = (group: LocationGroup) =>
  group.parts.flatMap((part) =>
    part.lageplans.length
      ? part.lageplans.map((plan, index) => ({
          part,
          plan: plan as GroupPlan | null,
          index,
        }))
      : [{ part, plan: null as GroupPlan | null, index: 0 }],
  );

/**
 * A merged project (helper/location_merge.py) in the portal: one bar with
 * the plans of all its parts - picking one opens its part with that plan,
 * so the group reads as one object with several plans. The parts keep
 * their own devices and data (they still receive under their old numbers).
 * The merged project itself opens its first part on the plan tabs.
 */
const LocationGroupBar = ({
  location,
  locationId,
}: {
  location: LocationDetail;
  locationId: number;
}) => {
  const auth = useAuth();
  const { t } = useTranslation();
  const { enqueueSnackbar } = useSnackbar();
  // Dissolving is merging undone: the same permission as the overview's merge button.
  const canMerge = usePermissions().hasPermission('module_locations_mergable');
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [searchParams] = useSearchParams();
  const [state, setState] = useState<{
    id: number;
    group: LocationGroup | null;
    canDissolve: boolean;
  } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const inGroup =
    location.parent_location != null ||
    (location.child_location_ids?.length ?? 0) > 0;
  const segment = portalSegment(pathname);

  useEffect(() => {
    if (!inGroup) {
      return;
    }
    void axiosConfig.perform_get(
      auth,
      `/v1/location-selection/group/?location=${locationId}`,
      (response) =>
        setState({
          id: locationId,
          group: (response?.data?.group ?? null) as LocationGroup | null,
          canDissolve: Boolean(response?.data?.can_dissolve),
        }),
    );
  }, [auth, inGroup, locationId]);

  const group = state?.id === locationId ? state.group : null;
  const isParent = group?.parent.id === locationId;
  const firstPart = group?.parts[0];

  // The merged project has no devices: its plan tabs show the first part.
  useEffect(() => {
    if (isParent && firstPart && PLAN_SEGMENTS.has(segment)) {
      navigate(locationPagePath(firstPart, segment), { replace: true });
    }
  }, [firstPart, isParent, navigate, segment]);

  if (!group) {
    return null;
  }
  const urlPlan = planFromParams(searchParams);
  const target = PLAN_SEGMENTS.has(segment) ? segment : 'status';

  const dissolve = () => {
    void axiosConfig.perform_post(
      auth,
      '/v1/location-selection/dissolve/',
      { location: group.parent.id },
      () => {
        showSuccessBar(enqueueSnackbar, t('location_group_dissolved'));
        navigate('/location/overview/');
      },
      (error) =>
        showRequestError(
          enqueueSnackbar,
          t('location_group_dissolve_failed'),
          error,
        ),
    );
  };

  return (
    <div className="location-group-bar" data-testid="location-group-bar">
      <span className="location-group-title">
        {t('location_group_title', {
          nr: group.parent.project_id ?? group.parent.id,
          name: group.parent.name ?? '',
        })}
      </span>
      <div className="location-group-plans">
        {groupPills(group).map(({ part, plan, index }) => {
          const active =
            part.id === locationId &&
            (plan == null ||
              plan.id === urlPlan ||
              (urlPlan == null && index === 0));
          return (
            <button
              key={`${part.id}-${plan?.id ?? 'part'}`}
              type="button"
              className={
                active ? 'location-group-plan is-active' : 'location-group-plan'
              }
              onClick={() =>
                navigate(locationPagePath(part, target, plan ? `${PLAN_PARAM}=${plan.id}` : ''))
              }
              data-testid="location-group-plan"
            >
              <span className="location-group-plan-part">
                #{part.project_id ?? part.id}
              </span>
              {plan
                ? plan.name || t('status_plan_view', { index: index + 1 })
                : part.name}
            </button>
          );
        })}
      </div>
      {canMerge && state?.canDissolve && (
        <button
          type="button"
          className="location-group-dissolve"
          onClick={() => setConfirming(true)}
          data-testid="location-group-dissolve"
        >
          {t('location_group_dissolve')}
        </button>
      )}
      <ConfirmDialog
        testId="location-group-dissolve-dialog"
        show={confirming}
        title={t('location_group_dissolve_title')}
        message={t('location_group_dissolve_message', {
          nr: group.parent.project_id ?? group.parent.id,
        })}
        confirmLabel={t('location_group_dissolve')}
        cancelLabel={t('rechte_cancel')}
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          dissolve();
        }}
      />
    </div>
  );
};

export default LocationGroupBar;
