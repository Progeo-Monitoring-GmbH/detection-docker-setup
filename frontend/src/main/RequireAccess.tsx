import type { ReactNode } from 'react';
import { Card, Container, Spinner } from 'react-bootstrap';
import { useTranslation } from 'react-i18next';
import { Navigate } from 'react-router';
import { useAuth } from '../../hooks/CoreAuthProvider';
import { useAccess, type AccessRule } from './access';

type RequireAccessProps = {
  rule: AccessRule;
  children: ReactNode;
  /** i18n key of the message shown without access. */
  deniedKey?: string;
};

/**
 * Route guard: renders `children` only if `rule` (access.ts) lets the user
 * in - a direct URL hit on a page the sidebar hides shows a message instead
 * of mounting the page (and firing its requests). The backend refuses those
 * requests anyway; this keeps the UI consistent with it.
 */
const RequireAccess = ({
  rule,
  children,
  deniedKey = 'page_no_access',
}: RequireAccessProps) => {
  const auth = useAuth();
  const { can, isLoading } = useAccess();
  const { t } = useTranslation();

  if (!auth.token) {
    const forward = encodeURIComponent(auth.location || '/');
    return <Navigate to={`/login?forward=${forward}`} replace />;
  }

  // The token is decoded into auth.user one render later.
  if (isLoading || !auth.user) {
    return (
      <Container fluid className="py-3" data-testid="require-access-loading">
        <div className="d-flex justify-content-center py-5 text-muted">
          <Spinner animation="border" />
        </div>
      </Container>
    );
  }

  if (!can(rule)) {
    return (
      <Container fluid className="py-3">
        <Card className="border-0 shadow-sm" data-testid="require-access-denied">
          <Card.Body className="py-5 text-center text-muted">
            {t(deniedKey)}
          </Card.Body>
        </Card>
      </Container>
    );
  }

  return <>{children}</>;
};

export default RequireAccess;
