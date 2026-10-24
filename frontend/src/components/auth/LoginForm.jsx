import React, { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Eye, EyeSlash } from 'react-bootstrap-icons';
import { useAuth } from '../../../hooks/CoreAuthProvider';
import AuthPage, {
  AuthLinks,
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
 */
const LoginForm = () => {
  const [searchParams] = useSearchParams();
  const { register, handleSubmit, formState } = useForm();
  const [showPasswd, setShowPasswd] = useState(false);
  const auth = useAuth();
  const { t } = useTranslation();

  const onSubmit = async (data) => {
    const forward = searchParams.get('forward') || '/v1/0/overview';
    await auth.loginAction(data, forward);
  };

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
        <Link to="/login/link">{t('login_magic_link')}</Link>
        <Link to="/zugang/beantragen">{t('login_request_access')}</Link>
      </AuthLinks>
    </AuthPage>
  );
};
export default LoginForm;
