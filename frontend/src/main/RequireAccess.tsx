import { useEffect, useState, type ReactNode } from 'react';
import { Button, Card, Container, Spinner } from 'react-bootstrap';
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
  const { can, isLoading, error, refreshPermissions } = useAccess();
  const { t } = useTranslation();
  const allowed = can(rule);
  // The permissions are loaded once per session token: a role granted since
  // (e.g. the mini admin) wouldn't count before the token rotates. Before
  // refusing, ask the backend once more.
  const [rechecked, setRechecked] = useState<'no' | 'running' | 'done'>('no');
  const settled = Boolean(auth.token && auth.user) && !isLoading;
  useEffect(() => {
    if (!settled || allowed || rechecked !== 'no') {
      return;
    }
    setRechecked('running');
    void refreshPermissions()
      .catch(() => undefined)
      .finally(() => setRechecked('done'));
  }, [settled, allowed, rechecked, refreshPermissions]);

  if (!auth.token) {
    const forward = encodeURIComponent(auth.location || '/');
    return <Navigate to={`/login?forward=${forward}`} replace />;
  }

  // The token is decoded into auth.user one render later.
  if (isLoading || !auth.user || (!allowed && rechecked !== 'done')) {
    return (
      <Container fluid className="py-3" data-testid="require-access-loading">
        <div className="d-flex justify-content-center py-5 text-muted">
          <Spinner animation="border" />
        </div>
      </Container>
    );
  }

  if (!allowed && error) {
    // Not "no access" - the permissions couldn't be loaded at all.
    return (
      <Container fluid className="py-3">
        <Card className="border-0 shadow-sm" data-testid="require-access-error">
          <Card.Body className="py-5 text-center text-muted">
            <div className="mb-3">{t('page_permissions_failed')}</div>
            <Button
              variant="outline-primary"
              size="sm"
              onClick={() => setRechecked('no')}
              data-testid="require-access-retry"
            >
              {t('page_permissions_retry')}
            </Button>
          </Card.Body>
        </Card>
      </Container>
    );
  }

  if (!allowed) {
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
