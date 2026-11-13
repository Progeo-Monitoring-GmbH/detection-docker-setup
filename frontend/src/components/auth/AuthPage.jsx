import React from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { PRIVACY_POLICY_URL } from '../privacy/consent';
import { COMPANY, telHref } from '../../main/company';
import './Auth.css';

/**
 * Class names of the auth pages' pill button (Auth.css); `secondary` is its
 * outlined variant, `extra` further modifier classes.
 */
export const authButtonClass = (busy = false, secondary = false, ...extra) =>
  [
    'auth-button',
    secondary ? 'auth-button--secondary' : '',
    busy ? 'auth-button--busy' : '',
    ...extra,
  ]
    .filter(Boolean)
    .join(' ');

/** Small centered links below a form (login page: magic link, request access). */
export const AuthLinks = ({ children }) => (
  <div className="auth-links" data-testid="auth-links">{children}</div>
);

/**
 * The public auth pages' frame (login, magic link, access request): a card
 * with the ProGeo logo, title and intro, the company's address and contact
 * below it and the privacy link in the footer. `testId` is the page root's
 * data-testid (each auth page passes its own `page-<name>`).
 */
const AuthPage = ({ title, intro, children, testId = 'page-auth' }) => {
  const { t } = useTranslation();

  return (
    <div className="auth-page" data-testid={testId}>
      <main className="auth-card" data-testid="auth-card">
        <div className="auth-brand">
          <img
            src="/assets/progeo-logo.png"
            alt="ProGeo"
            className="auth-logo"
          />
          <div className="auth-caption">{t('nav_portal_title')}</div>
        </div>

        {title && <h1 className="auth-title" data-testid="auth-title">{title}</h1>}
        {intro && <p className="auth-muted" data-testid="auth-intro">{intro}</p>}

        {children}
      </main>

      <address className="auth-address" data-testid="auth-address">
        <div>
          <div className="auth-caption auth-caption--label">
            {t('login_company')}
          </div>
          <strong className="auth-company">
            {COMPANY.name}
          </strong>
          <br />
          {COMPANY.street}
          <br />
          {COMPANY.postalCity}
        </div>
        <div>
          <div className="auth-caption auth-caption--label">
            {t('login_contact')}
          </div>
          {t('login_phone')}:{' '}
          <a href={telHref(COMPANY.phone)} data-testid="auth-contact-phone">{COMPANY.phone}</a>
          <br />
          {t('login_fax')}: {COMPANY.fax}
          <br />
          {t('login_email')}:{' '}
          <a href={`mailto:${COMPANY.email}`} data-testid="auth-contact-email">{COMPANY.email}</a>
        </div>
      </address>

      <footer className="auth-footer" data-testid="auth-footer">
        <span>
          © {new Date().getFullYear()} {COMPANY.name}
        </span>
        <span aria-hidden="true">·</span>
        <Link to={PRIVACY_POLICY_URL} data-testid="auth-privacy-link">{t('consent_privacy_policy')}</Link>
      </footer>
    </div>
  );
};

export default AuthPage;
