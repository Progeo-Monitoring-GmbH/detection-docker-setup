import React from 'react';
import { ChatDotsFill, X } from 'react-bootstrap-icons';
import { useTranslation } from 'react-i18next';

import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig';
import PillButton from '../components/ui/kit/PillButton';
import type { MatrixAccount } from './MatrixChatSection';
import MatrixSetupModal from './MatrixSetupModal';
import './MatrixPromoBanner.css';

const DISMISS_KEY = 'progeo:matrix-promo-dismissed';

const dismissed = () => {
  try {
    return window.localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
};

/**
 * "Alarme sofort aufs Handy": recommends the ProGeo chat (Matrix) where
 * notifications are set up - until the user made it the primary channel or
 * closed the banner (remembered in this browser). Opens the setup dialog.
 */
const MatrixPromoBanner = () => {
  const auth = useAuth();
  const { t } = useTranslation();
  const [account, setAccount] = React.useState<MatrixAccount | null>(null);
  const [hidden, setHidden] = React.useState(dismissed);
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    if (hidden) {
      return;
    }
    void axiosConfig.perform_get(
      auth,
      '/v1/user/profile/',
      (response) => setAccount((response?.data?.matrix as MatrixAccount | null) || null),
      () => {},
    );
  }, [auth, hidden]);

  if (hidden || !account || account.primary) {
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
      <button type="button" className="matrix-promo-close" onClick={dismiss} aria-label={t('matrix_promo_dismiss')} data-testid="matrix-promo-dismiss">
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
