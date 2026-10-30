import { useTranslation } from 'react-i18next';
import EmailRequestPage from '../components/auth/EmailRequestPage';

/**
 * "Anmeldelink per E-Mail" (/login/link): the backend mails a one-time login
 * link if the address belongs to an account. The page always shows the same
 * confirmation, so it doesn't reveal which addresses are registered.
 */
const MagicLinkRequest = () => {
  const { t } = useTranslation();
  return (
    <EmailRequestPage
      endpoint="/api/auth-support/login-link/"
      title={t('magic_link_title')}
      intro={t('magic_link_intro')}
      submitLabel={t('magic_link_submit')}
      sentText={t('magic_link_sent_text')}
    />
  );
};

export default MagicLinkRequest;
