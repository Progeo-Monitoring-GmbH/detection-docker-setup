import { useEffect, useState } from 'react';
import { ChatDotsFill, X } from 'react-bootstrap-icons';
import { useTranslation } from 'react-i18next';

import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import usePermissions from '../../hooks/usePermissions';
import axiosConfig from '../axiosConfig';
import PillButton from '../components/ui/kit/PillButton';
import { staffFlags } from './access';
import MatrixSetupModal, { type MatrixAccount } from './MatrixSetupModal';
import './MatrixPromoBanner.css';

export const DISMISS_KEY = 'progeo:matrix-promo-dismissed';

const dismissed = () => {
  try {
    return window.localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
};

/** Who is offered the ProGeo chat here: staff (is_staff - not while viewing
 * as a normal user) and customer admins (module_customer_admin_enabled). */
export const useMatrixPromoAudience = () => {
  const auth = useAuth();
  const { hasPermission, isLoading } = usePermissions();
  return !isLoading && (staffFlags(auth?.user).isStaff || hasPermission('module_customer_admin_enabled'));
};

/**
 * "Alarme sofort aufs Handy": recommends the ProGeo chat (Matrix) on the
 * notifications tab - to staff and customer admins, until the user made it
 * the primary channel or closed the banner (remembered in this browser).
 * Opens the setup dialog (MatrixSetupModal).
 */
const MatrixPromoBanner = () => {
  const auth = useAuth();
  const { t } = useTranslation();
  const audience = useMatrixPromoAudience();
  const [account, setAccount] = useState<MatrixAccount | null>(null);
  const [hidden, setHidden] = useState(dismissed);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (hidden || !audience) {
      return;
    }
    void axiosConfig.perform_get(
      auth,
      '/v1/user/profile/',
      (response) => setAccount((response?.data?.matrix as MatrixAccount | null) || null),
      () => {},
    );
  }, [auth, hidden, audience]);

  if (!audience || hidden || !account || account.primary) {
    return null;
  }

  const dismiss = () => {
    try {
      window.localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      // Private mode: hidden for this page view only.
    }
    setHidden(true);
  };

  return (
    <div className="matrix-promo" data-testid="matrix-promo">
      <ChatDotsFill size={26} className="matrix-promo-icon" />
      <div className="matrix-promo-text">
        <strong>{t('matrix_promo_title')}</strong>
        <span>{t('matrix_pitch')}</span>
      </div>
      <PillButton
        variant="accent"
        label={account.connected_at ? t('matrix_make_primary') : t('matrix_setup_open')}
        onClick={() => setOpen(true)}
        testId="matrix-promo-open"
      />
      <button
        type="button"
        className="matrix-promo-close"
        onClick={dismiss}
        aria-label={t('matrix_promo_dismiss')}
        data-testid="matrix-promo-dismiss"
      >
        <X size={18} />
      </button>
      <MatrixSetupModal
        show={open}
        initialStep={account.connected_at ? 3 : 1}
        onHide={() => setOpen(false)}
        account={account}
        onConnected={(connectedAt) => setAccount((current) => (current ? { ...current, connected_at: connectedAt } : current))}
        onPrimary={() => setAccount((current) => (current ? { ...current, primary: true } : current))}
      />
    </div>
  );
};

export default MatrixPromoBanner;
