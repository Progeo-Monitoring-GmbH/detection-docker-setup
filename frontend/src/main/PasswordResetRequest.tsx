import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { MUTED_TEXT } from '../components/auth/AuthPage';
import EmailRequestPage from '../components/auth/EmailRequestPage';

/**
 * "Passwort vergessen" (/passwort-vergessen): the backend mails a reset link
 * (/passwort/neu/<token>) - only to users with 2FA, a mailbox alone must not
 * be enough to take over an account. Everyone else gets a mail explaining
 * the way in (login link, then 2FA in the profile). The page always shows
 * the same confirmation, so it doesn't reveal which addresses are registered.
 */
const PasswordResetRequest = () => {
  const { t } = useTranslation();
  return (
    <EmailRequestPage
      endpoint="/api/auth-support/password-reset/"
      title={t('password_reset_title')}
      intro={t('password_reset_intro')}
      notice={<p style={MUTED_TEXT}>{t('password_reset_2fa_hint')}</p>}
      submitLabel={t('password_reset_submit')}
      sentText={t('password_reset_sent_text')}
      extraLinks={<Link to="/login/link">{t('login_magic_link')}</Link>}
    />
  );
};

export default PasswordResetRequest;
