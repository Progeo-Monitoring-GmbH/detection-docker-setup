import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../hooks/CoreAuthProvider';
import AuthPage from '../components/auth/AuthPage';
import {
  NewPasswordForm,
  OtpField,
  TokenStatePage,
  passwordFailure,
  useNewPassword,
  useTokenCheck,
} from '../components/auth/TokenPasswordPage';

/**
 * Target of the migration info mail (/account/setup/<token>, backend
 * helper/migration_invites.py): users of the old platform choose their
 * password on the new one and are signed in right away. Loading the page
 * only checks the token (mail scanners open every link); the button sets
 * the password. Users with 2FA enter their code as a second step.
 */
const MigrationSetup = () => {
  const { token } = useParams();
  const auth = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { state, setState, identity, firstName } = useTokenCheck(
    token,
    '/api/auth-support/migration/check/',
    'username',
  );
  const { password, submit, setErrors, fieldProps } = useNewPassword();
  const [otpStep, setOtpStep] = useState(false);
  const [otp, setOtp] = useState('');

  const onSubmit = (event: React.FormEvent) =>
    submit(
      event,
      '/api/auth-support/migration/confirm/',
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
        const failure = passwordFailure(err, t, 'migration_setup_error');
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
        title={t('migration_setup_title')}
        pageTestId="page-migration-setup"
        testId="migration-setup"
        invalidMessage={t('migration_setup_invalid')}
      >
        <Link to="/login/link" data-testid="migration-setup-request-link">
          {t('login_magic_link')}
        </Link>
        <Link to="/login" data-testid="auth-back-to-login">
          {t('auth_back_to_login')}
        </Link>
      </TokenStatePage>
    );
  }

  return (
    <AuthPage
      title={t('migration_setup_title')}
      intro={t('migration_setup_intro', { name: firstName || identity })}
      testId="page-migration-setup"
    >
      <NewPasswordForm
        testId="migration-setup"
        identityLabel={t('login_email')}
        identityKind="username"
        identity={identity}
        passwordLabel={t('migration_setup_password')}
        {...fieldProps}
        submitLabel={t('migration_setup_submit')}
        onSubmit={onSubmit}
      >
        {otpStep && <OtpField value={otp} onChange={setOtp} testId="migration-setup-otp" />}
      </NewPasswordForm>
    </AuthPage>
  );
};

export default MigrationSetup;
