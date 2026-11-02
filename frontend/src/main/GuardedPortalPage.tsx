import type { ReactNode } from 'react';
import { portalItemRule } from './access';
import type { PortalNavItem } from './portalNav';
import RequireAccess from './RequireAccess';

type GuardedPortalPageProps = {
  item: PortalNavItem;
  children: ReactNode;
};

/**
 * Wraps one portal section's content with the same rule the sidebar uses to
 * decide whether to show its nav item (access.ts portalItemRule) - so a
 * direct URL hit on a section the user can't access shows the access-denied
 * message instead of the section's content.
 */
const GuardedPortalPage = ({ item, children }: GuardedPortalPageProps) => (
  <RequireAccess rule={portalItemRule(item)} deniedKey="portal_no_access">
    {children}
  </RequireAccess>
);

export default GuardedPortalPage;
