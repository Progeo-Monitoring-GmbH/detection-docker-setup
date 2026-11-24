import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../hooks/CoreAuthProvider';
import AuthPage from '../components/auth/AuthPage';
import PasswordStrengthMeter from '../components/ui/PasswordStrengthMeter';
import {
  NewPasswordForm,
  OtpField,
  TokenStatePage,
  passwordFailure,
  useNewPassword,
  useTokenCheck,
} from '../components/auth/TokenPasswordPage';

/**
 * Target of an invitation mail (/account/invite/<token>, backend
 * helper/login_links.py confirm_invite): the invited user sets a password
 * first - only that redeems the invitation and signs them in; the link never
 * logs in by itself. Loading the page only checks the token (mail scanners
 * open every link). Users with 2FA enter their code as a second step.
 */
const InviteSetup = () => {
  const { token } = useParams();
  const auth = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { state, setState, identity, firstName } = useTokenCheck(
    token,
    '/api/auth-support/invite/check/',
    'username',
  );
  const { password, submit, setErrors, fieldProps } = useNewPassword();
  const [otpStep, setOtpStep] = useState(false);
  const [otp, setOtp] = useState('');

  const onSubmit = (event: React.FormEvent) =>
    submit(
      event,
      '/api/auth-support/invite/confirm/',
      otpStep ? { token, password, otp: otp.trim() } : { token, password },
      (response) => {
        auth.loginWithTokens(response.data.access, response.data.refresh);
        navigate('/', { replace: true });
      },
      (err) => {
        const data = err?.response?.data || {};
        if (data.otp_required) {
          setOtpStep(true);
          setErrors(data.reason === 'otp_invalid' ? [t('login_otp_invalid')] : []);
          return;
        }
        const failure = passwordFailure(err, t, 'invite_setup_error');
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
        title={t('invite_setup_title')}
        pageTestId="page-invite-setup"
        testId="invite-setup"
        invalidMessage={t('invite_setup_invalid')}
      >
        <Link to="/login" data-testid="auth-back-to-login">
          {t('auth_back_to_login')}
        </Link>
        <Link to="/login/link" data-testid="invite-setup-request-link">
          {t('login_magic_link')}
        </Link>
      </TokenStatePage>
    );
  }

  return (
    <AuthPage
      title={t('invite_setup_title')}
      intro={t('invite_setup_intro', { name: firstName || identity })}
      testId="page-invite-setup"
    >
      <NewPasswordForm
        testId="invite-setup"
        identityLabel={t('login_email')}
        identityKind="username"
        identity={identity}
        passwordLabel={t('invite_setup_password')}
        {...fieldProps}
        submitLabel={t('invite_setup_submit')}
        onSubmit={onSubmit}
      >
        {/* The rule the backend checks, too (helper/password_rules.py). */}
        <PasswordStrengthMeter password={password} testId="invite-setup-strength" />
        {otpStep && <OtpField value={otp} onChange={setOtp} testId="invite-setup-otp" />}
      </NewPasswordForm>
    </AuthPage>
  );
};

export default InviteSetup;
