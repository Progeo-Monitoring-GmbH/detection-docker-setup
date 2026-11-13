import { Navigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../hooks/CoreAuthProvider';
import AuthPage, { authButtonClass } from '../components/auth/AuthPage';
import TwoFactorSettings from './TwoFactorSettings';
import { needsTwoFactorSetup } from './twoFactor';

/**
 * The only page of a staff member who has to set up 2FA first (JWT claim
 * `two_factor_setup_required`, see PendingGate) - the backend refuses
 * everything else but the profile. Confirming the setup replaces the
 * tokens with ones without the claim; then the portal opens again.
 */
const TwoFactorSetupRequired = () => {
  const auth = useAuth();
  const { t } = useTranslation();

  if (!auth.token) {
    return <Navigate to="/login" replace />;
  }

  const done = !needsTwoFactorSetup(auth.user);

  return (
    <AuthPage title={t('tfa_required_title')} testId="page-two-factor-setup">
      <p className="auth-muted">{t('tfa_required_text')}</p>
      <TwoFactorSettings />
      {done ? (
        <button
          type="button"
          className={authButtonClass(false, false, 'auth-button--block', 'auth-button--spaced')}
          onClick={() => auth.navigate('/', { replace: true })}
          data-testid="two-factor-setup-continue"
        >
          {t('tfa_required_continue')}
        </button>
      ) : (
        <button
          type="button"
          className={authButtonClass(false, true, 'auth-button--block', 'auth-button--spaced')}
          onClick={() => auth.logoutAction()}
          data-testid="two-factor-setup-logout"
        >
          {t('pending_logout')}
        </button>
      )}
    </AuthPage>
  );
};

export default TwoFactorSetupRequired;
