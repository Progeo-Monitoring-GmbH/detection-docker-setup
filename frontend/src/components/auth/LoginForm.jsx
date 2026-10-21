import React, { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Eye, EyeSlash } from 'react-bootstrap-icons';
import { useAuth } from '../../../hooks/CoreAuthProvider';
import { PRIVACY_POLICY_URL } from '../privacy/consent';
import { COMPANY, telHref } from '../../main/company';

const FIELD_LABEL = {
  fontSize: 11,
  letterSpacing: '.07em',
  textTransform: 'uppercase',
  color: '#8B8383',
  fontWeight: 500,
};

// The soft-surface input of the kit (LabeledInput), uncontrolled for react-hook-form.
const FIELD = {
  height: 42,
  border: 'none',
  borderRadius: 11,
  background: 'var(--progeo-surface)',
  boxShadow: '0 1px 4px rgba(11, 54, 89, .09)',
  padding: '0 13px',
  fontFamily: 'inherit',
  fontSize: 14,
  color: 'var(--progeo-blue)',
  width: '100%',
};

const CAPTION = {
  fontSize: 10,
  letterSpacing: '.12em',
  textTransform: 'uppercase',
  color: '#6E6868',
  fontWeight: 600,
};

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
    <div
      style={{
        minHeight: '100vh',
        background: 'var(--progeo-page-bg)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: '56px 16px 24px',
        color: 'var(--progeo-blue)',
      }}
    >
      <main
        style={{
          width: '100%',
          maxWidth: 420,
          background: 'var(--progeo-panel-bg)',
          borderRadius: 'var(--progeo-radius-panel)',
          boxShadow: 'var(--progeo-shadow-panel)',
          padding: '36px 32px 32px',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
          <img src="/assets/progeo-logo.png" alt="ProGeo" style={{ height: 40, width: 'auto' }} />
          <div style={CAPTION}>{t('nav_portal_title')}</div>
        </div>

        <h1 style={{ fontSize: 20, fontWeight: 700, margin: '28px 0 4px' }}>{t('login_title')}</h1>
        <p style={{ fontSize: 13, color: '#6E6868', margin: '0 0 22px' }}>{t('login_intro')}</p>

        <form onSubmit={handleSubmit(onSubmit)} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 5, margin: 0 }}>
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

          <label style={{ display: 'flex', flexDirection: 'column', gap: 5, margin: 0 }}>
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
                aria-label={showPasswd ? t('login_hide_password') : t('login_show_password')}
                title={showPasswd ? t('login_hide_password') : t('login_show_password')}
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
            style={{
              marginTop: 10,
              height: 42,
              border: 'none',
              borderRadius: 'var(--progeo-radius-pill)',
              background: 'var(--progeo-blue)',
              color: 'var(--progeo-white)',
              fontFamily: 'inherit',
              fontSize: 14,
              fontWeight: 600,
              cursor: formState.isSubmitting ? 'default' : 'pointer',
              opacity: formState.isSubmitting ? 0.7 : 1,
            }}
          >
            {t('login_submit')}
          </button>
        </form>
      </main>

      <address
        style={{
          width: '100%',
          maxWidth: 420,
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
          gap: '18px 24px',
          margin: '28px 0 0',
          padding: '0 8px',
          fontStyle: 'normal',
          fontSize: 12.5,
          lineHeight: 1.6,
          color: '#4f4949',
        }}
      >
        <div>
          <div style={{ ...CAPTION, marginBottom: 6 }}>{t('login_company')}</div>
          <strong style={{ color: 'var(--progeo-blue)', fontWeight: 600 }}>{COMPANY.name}</strong>
          <br />
          {COMPANY.street}
          <br />
          {COMPANY.postalCity}
        </div>
        <div>
          <div style={{ ...CAPTION, marginBottom: 6 }}>{t('login_contact')}</div>
          {t('login_phone')}: <a href={telHref(COMPANY.phone)}>{COMPANY.phone}</a>
          <br />
          {t('login_fax')}: {COMPANY.fax}
          <br />
          {t('login_email')}: <a href={`mailto:${COMPANY.email}`}>{COMPANY.email}</a>
        </div>
      </address>

      <footer
        style={{
          // Not the portal's global dark footer bar (scss/style.scss).
          background: 'transparent',
          padding: '32px 0 0',
          marginTop: 'auto',
          fontSize: 12,
          color: '#6E6868',
          display: 'flex',
          gap: 8,
          flexWrap: 'wrap',
          justifyContent: 'center',
        }}
      >
        <span>© {new Date().getFullYear()} {COMPANY.name}</span>
        <span aria-hidden="true">·</span>
        <Link to={PRIVACY_POLICY_URL}>{t('consent_privacy_policy')}</Link>
      </footer>
    </div>
  );
};
export default LoginForm;
