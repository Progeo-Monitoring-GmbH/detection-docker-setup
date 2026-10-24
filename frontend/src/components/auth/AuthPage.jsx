import React from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { PRIVACY_POLICY_URL } from '../privacy/consent';
import { COMPANY, telHref } from '../../main/company';

export const FIELD_LABEL = {
  fontSize: 11,
  letterSpacing: '.07em',
  textTransform: 'uppercase',
  color: '#8B8383',
  fontWeight: 500,
};

// The soft-surface input of the kit (LabeledInput), uncontrolled for react-hook-form.
export const FIELD = {
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

export const CAPTION = {
  fontSize: 10,
  letterSpacing: '.12em',
  textTransform: 'uppercase',
  color: '#6E6868',
  fontWeight: 600,
};

export const MUTED_TEXT = {
  fontSize: 13,
  color: '#6E6868',
  margin: '0 0 22px',
};

export const FORM = { display: 'flex', flexDirection: 'column', gap: 16 };

export const LABEL = {
  display: 'flex',
  flexDirection: 'column',
  gap: 5,
  margin: 0,
};

export const ERROR_TEXT = { fontSize: 12.5, color: '#b42318', margin: 0 };

/** The pill button of the login page; `secondary` is its outlined variant. */
export const buttonStyle = (busy = false, secondary = false) => ({
  marginTop: 10,
  height: 42,
  border: secondary ? '1px solid var(--progeo-blue)' : 'none',
  borderRadius: 'var(--progeo-radius-pill)',
  background: secondary ? 'transparent' : 'var(--progeo-blue)',
  color: secondary ? 'var(--progeo-blue)' : 'var(--progeo-white)',
  fontFamily: 'inherit',
  fontSize: 14,
  fontWeight: 600,
  padding: '0 20px',
  cursor: busy ? 'default' : 'pointer',
  opacity: busy ? 0.7 : 1,
});

/** Small centered links below a form (login page: magic link, request access). */
export const AuthLinks = ({ children }) => (
  <div
    style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 6,
      marginTop: 20,
      fontSize: 13,
    }}
  >
    {children}
  </div>
);

/**
 * The public auth pages' frame (login, magic link, access request): a card
 * with the ProGeo logo, title and intro, the company's address and contact
 * below it and the privacy link in the footer.
 */
const AuthPage = ({ title, intro, children }) => {
  const { t } = useTranslation();

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
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <img
            src="/assets/progeo-logo.png"
            alt="ProGeo"
            style={{ height: 40, width: 'auto' }}
          />
          <div style={CAPTION}>{t('nav_portal_title')}</div>
        </div>

        {title && (
          <h1 style={{ fontSize: 20, fontWeight: 700, margin: '28px 0 4px' }}>
            {title}
          </h1>
        )}
        {intro && <p style={MUTED_TEXT}>{intro}</p>}

        {children}
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
          <div style={{ ...CAPTION, marginBottom: 6 }}>
            {t('login_company')}
          </div>
          <strong style={{ color: 'var(--progeo-blue)', fontWeight: 600 }}>
            {COMPANY.name}
          </strong>
          <br />
          {COMPANY.street}
          <br />
          {COMPANY.postalCity}
        </div>
        <div>
          <div style={{ ...CAPTION, marginBottom: 6 }}>
            {t('login_contact')}
          </div>
          {t('login_phone')}:{' '}
          <a href={telHref(COMPANY.phone)}>{COMPANY.phone}</a>
          <br />
          {t('login_fax')}: {COMPANY.fax}
          <br />
          {t('login_email')}:{' '}
          <a href={`mailto:${COMPANY.email}`}>{COMPANY.email}</a>
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
        <span>
          © {new Date().getFullYear()} {COMPANY.name}
        </span>
        <span aria-hidden="true">·</span>
        <Link to={PRIVACY_POLICY_URL}>{t('consent_privacy_policy')}</Link>
      </footer>
    </div>
  );
};

export default AuthPage;
