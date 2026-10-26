import React, { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Eye, EyeSlash } from 'react-bootstrap-icons';
import { useAuth } from '../../../hooks/CoreAuthProvider';
import AuthPage, {
  AuthLinks,
  ERROR_TEXT,
  FIELD,
  FIELD_LABEL,
  FORM,
  LABEL,
  buttonStyle,
} from './AuthPage';

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
  const { register, handleSubmit, formState, resetField } = useForm();
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
      <AuthPage title={t('login_otp_title')} intro={t('login_otp_intro')}>
        <form onSubmit={handleSubmit(onSubmit)} style={FORM}>
          <label style={LABEL}>
            <span style={FIELD_LABEL}>{t('login_otp_code')}</span>
            <input
              type="text"
              autoComplete="one-time-code"
              autoFocus
              required
              style={FIELD}
              {...register('otp')}
            />
          </label>
          {otpStep === 'otp_invalid' && (
            <p style={ERROR_TEXT}>{t('login_otp_invalid')}</p>
          )}
          <button
            type="submit"
            disabled={formState.isSubmitting}
            style={buttonStyle(formState.isSubmitting)}
          >
            {t('login_otp_submit')}
          </button>
        </form>

        <AuthLinks>
          <button
            type="button"
            onClick={backToCredentials}
            className="btn btn-link p-0"
            style={{ fontSize: 13 }}
          >
            {t('login_otp_back')}
          </button>
        </AuthLinks>
      </AuthPage>
    );
  }

  return (
    <AuthPage title={t('login_title')} intro={t('login_intro')}>
      <form onSubmit={handleSubmit(onSubmit)} style={FORM}>
        <label style={LABEL}>
          <span style={FIELD_LABEL}>{t('login_username')}</span>
          <input
            type="text"
            autoComplete="username"
            autoFocus
            required
            style={FIELD}
            {...register('username')}
          />
        </label>

        <label style={LABEL}>
          <span style={FIELD_LABEL}>{t('login_password')}</span>
          <span style={{ position: 'relative', display: 'block' }}>
            <input
              type={showPasswd ? 'text' : 'password'}
              autoComplete="current-password"
              required
              style={{ ...FIELD, paddingRight: 44 }}
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
              style={{
                position: 'absolute',
                right: 6,
                top: 6,
                width: 30,
                height: 30,
                border: 'none',
                borderRadius: 'var(--progeo-radius-pill)',
                background: 'transparent',
                color: '#6E6868',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
              }}
            >
              {showPasswd ? <EyeSlash /> : <Eye />}
            </button>
          </span>
        </label>

        <button
          type="submit"
          disabled={formState.isSubmitting}
          style={buttonStyle(formState.isSubmitting)}
        >
          {t('login_submit')}
        </button>
      </form>

      <AuthLinks>
        <Link to="/passwort-vergessen">{t('login_forgot_password')}</Link>
        <Link to="/login/link">{t('login_magic_link')}</Link>
        <Link to="/zugang/beantragen">{t('login_request_access')}</Link>
      </AuthLinks>
    </AuthPage>
  );
};
export default LoginForm;
