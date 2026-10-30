import { Navigate, Outlet } from 'react-router';
import { useAuth } from '../../hooks/CoreAuthProvider';
import { needsTwoFactorSetup, TWO_FACTOR_SETUP_PATH } from './twoFactor';

/** True for a user whose access request still waits for the staff's review. */
const isPendingUser = (user: unknown) =>
  Boolean((user as { is_pending?: boolean } | null)?.is_pending);

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
    return <Navigate to="/zugang/pruefung" replace />;
  }
  if (needsTwoFactorSetup(auth.user)) {
    return <Navigate to={TWO_FACTOR_SETUP_PATH} replace />;
  }
  return <Outlet />;
};

export default PendingGate;
