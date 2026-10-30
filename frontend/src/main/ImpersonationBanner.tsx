import { Alert, Button } from 'react-bootstrap';
import { Incognito } from 'react-bootstrap-icons';
import { Trans, useTranslation } from 'react-i18next';

import { useAuth } from '../../hooks/CoreAuthProvider';
import { impersonatorOf, stopImpersonation } from './impersonation';

/** Shown on every page while a superuser is logged in as another user. */
const ImpersonationBanner = () => {
  const { t } = useTranslation();
  const auth = useAuth();
  const impersonator = impersonatorOf(auth.user);
  if (!impersonator) {
    return null;
  }
  const username = (auth.user as { username?: string } | null)?.username || '';

  return (
    <Alert
      variant="warning"
      className="d-flex flex-wrap align-items-center justify-content-between gap-2 py-2 mb-0"
    >
      <span>
        <Incognito className="me-2" />
        <Trans
          i18nKey="impersonation_banner"
          values={{ username, impersonator }}
          components={{ strong: <strong /> }}
        />
      </span>
      <Button
        size="sm"
        variant="dark"
        onClick={() => stopImpersonation(auth, '/staff/')}
      >
        {t('impersonation_back')}
      </Button>
    </Alert>
  );
};

export default ImpersonationBanner;
