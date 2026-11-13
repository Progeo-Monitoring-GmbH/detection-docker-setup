import React, { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Eye, EyeSlash } from 'react-bootstrap-icons';
import { useAuth } from '../../../hooks/CoreAuthProvider';
import { oidcLoginHint } from '../../main/oidcForward';
import AuthPage, { AuthLinks, authButtonClass } from './AuthPage';

/**
 * The portal's login: a card with the ProGeo logo and the sign-in form,
 * the company's address and contact below it - the portal is a ProGeo
 * product, the page is the first thing customers see of it.
 *
 * Users with 2FA get a second step: the password was right, now the code
 * from the authenticator app (or a recovery code) - username and password
 * are sent again with it (the form keeps their values meanwhile).
 */
const LoginForm = () => {
  const [searchParams] = useSearchParams();
  // From the chat app's login link (QR code in Mein Konto).
  const { register, handleSubmit, formState, resetField } = useForm({
    defaultValues: { username: oidcLoginHint(searchParams.get('forward')) },
  });
  const [showPasswd, setShowPasswd] = useState(false);
  // null: credentials; 'otp_required'/'otp_invalid': the 2FA step.
  const [otpStep, setOtpStep] = useState(null);
  const auth = useAuth();
  const { t } = useTranslation();

  const onSubmit = async (data) => {
    const forward = searchParams.get('forward') || '/v1/0/overview';
    const outcome = await auth.loginAction(
      otpStep ? data : { username: data.username, password: data.password },
      forward,
    );
    if (outcome === 'otp_required' || outcome === 'otp_invalid') {
      setOtpStep(outcome);
      resetField('otp');
    } else {
      setOtpStep(null);
    }
  };

  const backToCredentials = () => {
    setOtpStep(null);
    resetField('otp');
  };

  if (otpStep) {
    return (
      <AuthPage title={t('login_otp_title')} intro={t('login_otp_intro')} testId="page-login">
        <form onSubmit={handleSubmit(onSubmit)} className="auth-form" data-testid="login-otp-form">
          <label className="auth-label">
            <span className="auth-field-label">{t('login_otp_code')}</span>
            <input
              type="text"
              autoComplete="one-time-code"
              autoFocus
              required
              className="auth-field"
              data-testid="login-otp"
              {...register('otp')}
            />
          </label>
          {otpStep === 'otp_invalid' && (
            <p className="auth-error" data-testid="login-otp-error">{t('login_otp_invalid')}</p>
          )}
          <button
            type="submit"
            disabled={formState.isSubmitting}
            className={authButtonClass(formState.isSubmitting)}
            data-testid="login-otp-submit"
          >
            {t('login_otp_submit')}
          </button>
        </form>

        <AuthLinks>
          <button
            type="button"
            onClick={backToCredentials}
            className="btn btn-link p-0 auth-link-button"
            data-testid="login-otp-back"
          >
            {t('login_otp_back')}
          </button>
        </AuthLinks>
      </AuthPage>
    );
  }

  return (
    <AuthPage title={t('login_title')} intro={t('login_intro')} testId="page-login">
      <form onSubmit={handleSubmit(onSubmit)} className="auth-form" data-testid="login-form">
        <label className="auth-label">
          <span className="auth-field-label">{t('login_username')}</span>
          <input
            type="text"
            autoComplete="username"
            autoFocus
            required
            className="auth-field"
            data-testid="login-username"
            {...register('username')}
          />
        </label>

        <label className="auth-label">
          <span className="auth-field-label">{t('login_password')}</span>
          <span className="auth-password-wrap">
            <input
              type={showPasswd ? 'text' : 'password'}
              autoComplete="current-password"
              required
              className="auth-field auth-field--password"
              data-testid="login-password"
              {...register('password')}
            />
            <button
              type="button"
              onClick={() => setShowPasswd((shown) => !shown)}
              aria-label={
                showPasswd ? t('login_hide_password') : t('login_show_password')
              }
              title={
                showPasswd ? t('login_hide_password') : t('login_show_password')
              }
              className="auth-password-toggle"
              data-testid="login-password-toggle"
            >
              {showPasswd ? <EyeSlash /> : <Eye />}
            </button>
          </span>
        </label>

        <button
          type="submit"
          disabled={formState.isSubmitting}
          className={authButtonClass(formState.isSubmitting)}
          data-testid="login-submit"
        >
          {t('login_submit')}
        </button>
      </form>

      <AuthLinks>
        <Link to="/passwort-vergessen" data-testid="login-forgot-password-link">{t('login_forgot_password')}</Link>
        <Link to="/login/link" data-testid="login-magic-link-link">{t('login_magic_link')}</Link>
        <Link to="/zugang/beantragen" data-testid="login-request-access-link">{t('login_request_access')}</Link>
      </AuthLinks>
    </AuthPage>
  );
};
export default LoginForm;
