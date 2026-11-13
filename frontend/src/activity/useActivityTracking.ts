import { useEffect } from 'react';
import { useLocation } from 'react-router';
import { useAuth } from '../../hooks/CoreAuthProvider';
import { useActivityTrackingFlag } from '../../hooks/usePermissions';
import { useConsent } from '../components/privacy/ConsentProvider';
import { impersonatorOf } from '../main/impersonation';
import { activityTracker, shouldTrack } from './activityTracker';

/**
 * Feeds the usage analysis (activityTracker.ts) - mounted once in App. On
 * only while all of these hold, and off again (dropping what is not sent
 * yet) as soon as one doesn't, e.g. consent withdrawn in the privacy
 * settings: logged in, the backend's flag (normal user, tracking enabled),
 * consent to "statistics", and not a staff account - neither in "show as
 * normal user" nor as a superuser logged in as someone else.
 */
const useActivityTracking = () => {
  const auth = useAuth();
  const { pathname } = useLocation();
  const { allows } = useConsent();
  const flag = useActivityTrackingFlag();
  const active = shouldTrack({
    loggedIn: Boolean(auth.token),
    flag,
    consent: allows('statistics'),
    staffAccount: auth.canViewAsUser,
    impersonated: Boolean(impersonatorOf(auth.user)),
  });

  // Before setActive: switching on starts the page view of this route.
  useEffect(() => {
    activityTracker().pageChanged(pathname);
  }, [pathname]);

  useEffect(() => {
    activityTracker().setActive(active);
  }, [active]);
};

/** Mount point of useActivityTracking (renders nothing). */
export const ActivityTracking = () => {
  useActivityTracking();
  return null;
};

