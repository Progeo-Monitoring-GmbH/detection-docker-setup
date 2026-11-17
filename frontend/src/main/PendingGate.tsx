import { Navigate, Outlet } from 'react-router';
import { useAuth } from '../../hooks/CoreAuthProvider';
import { needsTwoFactorSetup, TWO_FACTOR_SETUP_PATH } from './twoFactor';
import { isPendingUser, PENDING_REVIEW_PATH } from './pendingReview';

/**
 * Layout route around the portal's layouts: a user whose access request is
 * not approved yet (JWT claim `is_pending`) only gets the "being checked"
 * panel, a staff member who has to set up 2FA first (claim
 * `two_factor_setup_required`) only that setup. The backend refuses those
 * users' other requests anyway.
 */
const PendingGate = () => {
  const auth = useAuth();
  if (isPendingUser(auth.user)) {
    return <Navigate to={PENDING_REVIEW_PATH} replace />;
  }
  if (needsTwoFactorSetup(auth.user)) {
    return <Navigate to={TWO_FACTOR_SETUP_PATH} replace />;
  }
  return <Outlet />;
};

export default PendingGate;
