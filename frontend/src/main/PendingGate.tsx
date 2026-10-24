import { Navigate, Outlet } from 'react-router';
import { useAuth } from '../../hooks/CoreAuthProvider';

/** True for a user whose access request still waits for the staff's review. */
export const isPendingUser = (user: unknown) =>
  Boolean((user as { is_pending?: boolean } | null)?.is_pending);

/**
 * Layout route around the portal's layouts: a user whose access request is
 * not approved yet (JWT claim `is_pending`) only gets the "being checked"
 * panel. The backend refuses that user's other requests anyway.
 */
const PendingGate = () => {
  const auth = useAuth();
  if (isPendingUser(auth.user)) {
    return <Navigate to="/zugang/pruefung" replace />;
  }
  return <Outlet />;
};

export default PendingGate;
