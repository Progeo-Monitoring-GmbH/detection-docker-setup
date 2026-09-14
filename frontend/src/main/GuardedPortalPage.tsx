import type { ReactNode } from 'react';
import { Card, Container, Spinner } from 'react-bootstrap';
import { useTranslation } from 'react-i18next';
import usePermissions from '../../hooks/usePermissions';
import type { PortalNavItem } from './portalNav';

type GuardedPortalPageProps = {
  item: PortalNavItem;
  children: ReactNode;
};

/**
 * Wraps one portal section's content with the same permission check the
 * sidebar uses to decide whether to show its nav item - so a direct URL hit
 * on a section the user can't access shows the access-denied message
 * instead of the section's content, matching LocationDetailView's old
 * per-tab gating (now enforced per-route instead).
 */
const GuardedPortalPage = ({ item, children }: GuardedPortalPageProps) => {
  const { hasPermission, isLoading } = usePermissions();
  const { t } = useTranslation();

  if (isLoading) {
    return (
      <Container fluid className="py-3">
        <div className="d-flex justify-content-center py-5 text-muted">
          <Spinner animation="border" />
        </div>
      </Container>
    );
  }

  if (!hasPermission(item.permission)) {
    return (
      <Container fluid className="py-3">
        <Card className="border-0 shadow-sm">
          <Card.Body className="py-5 text-center text-muted">{t('portal_no_access')}</Card.Body>
        </Card>
      </Container>
    );
  }

  return <>{children}</>;
};

export default GuardedPortalPage;
