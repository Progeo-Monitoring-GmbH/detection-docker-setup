import { Link, useNavigate, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../hooks/CoreAuthProvider';
import AuthPage from '../components/auth/AuthPage';
import {
  NewPasswordForm,
  TokenStatePage,
  passwordFailure,
  useNewPassword,
  useTokenCheck,
} from '../components/auth/TokenPasswordPage';
import { PENDING_REVIEW_PATH } from './pendingReview';

/**
 * Confirmation link of an access request (/access/verify/<token>). The
 * token is only checked on load (no side effect - mail scanners open the
 * link too); choosing a password confirms the address, creates the account
 * and logs the user in. Until the staff approved the request the portal
 * shows nothing but the "being checked" panel (PendingReview).
 */
const VerifyAccess = () => {
  const { token } = useParams();
  const auth = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { state, setState, identity, firstName } = useTokenCheck(
    token,
    '/api/auth-support/access-requests/verify/check/',
    'email',
  );
  const { password, submit, setErrors, fieldProps } = useNewPassword();

  const onSubmit = (event: React.FormEvent) =>
    submit(
      event,
      '/api/auth-support/access-requests/verify/',
      { token, password },
      (response) => {
        auth.loginWithTokens(response.data.access, response.data.refresh);
        navigate(PENDING_REVIEW_PATH, { replace: true });
      },
      (err) => {
        const failure = passwordFailure(err, t, 'access_verify_error');
        if (failure) {
          setErrors(failure);
        } else {
          setState('invalid');
        }
      },
    );

  if (state !== 'ready') {
    return (
      <TokenStatePage
        state={state}
        title={t('access_verify_title')}
        pageTestId="page-verify-access"
        testId="verify-access"
        invalidMessage={t('access_verify_invalid')}
      >
        <Link to="/access/request" data-testid="verify-access-request-access-link">{t('login_request_access')}</Link>
        <Link to="/login" data-testid="auth-back-to-login">{t('auth_back_to_login')}</Link>
      </TokenStatePage>
    );
  }

  return (
    <AuthPage
      title={t('access_verify_title')}
      intro={t('access_verify_intro', { name: firstName || identity })}
      testId="page-verify-access"
    >
      <NewPasswordForm
        testId="verify-access"
        identityLabel={t('access_email')}
        identityKind="email"
        identity={identity}
        passwordLabel={t('login_password')}
        {...fieldProps}
        submitLabel={t('access_verify_submit')}
        onSubmit={onSubmit}
      />
    </AuthPage>
  );
};

export default VerifyAccess;
