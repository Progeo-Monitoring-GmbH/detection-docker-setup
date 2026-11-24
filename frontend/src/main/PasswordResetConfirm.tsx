import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../hooks/CoreAuthProvider';
import AuthPage from '../components/auth/AuthPage';
import { internalPath } from '../internalPath';
import {
  NewPasswordForm,
  OtpField,
  TokenStatePage,
  passwordFailure,
  useNewPassword,
  useTokenCheck,
} from '../components/auth/TokenPasswordPage';

/**
 * Reset link from the "Passwort vergessen" mail (/password/reset/<token>) -
 * or the change link a normal user asked for in Mein Konto. Like
 * VerifyAccess, the token is only checked on load (no side effect - mail
 * scanners open the link too); the new password is only set on the button
 * press, together with the code from the authenticator app (a mailbox alone
 * is not enough) - not for a change link of a user without 2FA (the check
 * says otp_required: asking for it took the login). Then the user is logged
 * in like with a login link - all other logins of the user ended.
 */
const PasswordResetConfirm = () => {
  const { token } = useParams();
  const auth = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { state, setState, identity, firstName, otpRequired } = useTokenCheck(
    token,
    '/api/auth-support/password-reset/check/',
    'username',
  );
  const { password, submit, setErrors, fieldProps } = useNewPassword();
  const [otp, setOtp] = useState('');

  const onSubmit = (event: React.FormEvent) =>
    submit(
      event,
      '/api/auth-support/password-reset/confirm/',
      { token, otp: otp.trim(), password },
      (response) => {
        auth.loginWithTokens(response.data.access, response.data.refresh);
        // Only paths inside the app - never another origin.
        navigate(internalPath(response.data.forward) ?? '/', { replace: true });
      },
      (err) => {
        const reason = err?.response?.data?.reason;
        if (reason === 'otp_invalid') {
          setOtp('');
          setErrors([t('login_otp_invalid')]);
          return;
        }
        if (reason === 'otp_required') {
          setErrors([t('password_new_otp_missing')]);
          return;
        }
        const failure = passwordFailure(err, t, 'password_new_error');
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
        title={t('password_new_title')}
        pageTestId="page-password-reset"
        testId="password-reset"
        invalidMessage={t('password_new_invalid')}
      >
        <Link to="/forgot-password" data-testid="password-reset-request-new">
          {t('password_new_request_new')}
        </Link>
        <Link to="/login" data-testid="auth-back-to-login">
          {t('auth_back_to_login')}
        </Link>
      </TokenStatePage>
    );
  }

  return (
    <AuthPage
      title={t('password_new_title')}
      intro={t('password_new_intro', { name: firstName || identity })}
      testId="page-password-reset"
    >
      <NewPasswordForm
        testId="password-reset"
        identityLabel={t('login_email')}
        identityKind="username"
        identity={identity}
        passwordLabel={t('profile_new_password')}
        {...fieldProps}
        submitLabel={t('password_new_submit')}
        onSubmit={onSubmit}
      >
        {/* A change link from Mein Konto of a user without 2FA needs no code. */}
        {otpRequired && <OtpField value={otp} onChange={setOtp} testId="password-reset-otp" />}
      </NewPasswordForm>
    </AuthPage>
  );
};

export default PasswordResetConfirm;
