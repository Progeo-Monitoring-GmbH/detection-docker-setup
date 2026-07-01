import React from 'react';
import CookieConsent from 'react-cookie-consent';

const PRIVACY_POLICY_URL = 'https://data-progeo.net/DB/datenschutztext.htm';

const CookieBanner = () => {
  return (
    <CookieConsent
      location="bottom"
      cookieName="progeo_cookie_consent"
      buttonText="Akzeptieren"
      declineButtonText="Ablehnen"
      enableDeclineButton={true}
      sameSite="Lax"
      expires={365}
      containerClasses="progeo-cookie-banner"
      style={{
        position: 'fixed',
        right: '16px',
        bottom: '16px',
        left: 'auto',
        width: 'min(380px, calc(100vw - 32px))',
        background: '#1d2735',
        color: '#ffffff',
        borderRadius: '10px',
        boxShadow: '0 10px 30px rgba(0, 0, 0, 0.25)',
        padding: '14px 14px 12px',
        fontSize: '13px',
        lineHeight: '1.4',
        zIndex: 2000,
      }}
      contentStyle={{ margin: '0 0 10px 0' }}
      buttonStyle={{
        background: '#00a7a0',
        color: '#ffffff',
        borderRadius: '6px',
        border: 'none',
        fontSize: '12px',
        padding: '7px 12px',
        marginRight: '8px',
      }}
      declineButtonStyle={{
        background: 'transparent',
        color: '#ffffff',
        border: '1px solid rgba(255, 255, 255, 0.5)',
        borderRadius: '6px',
        fontSize: '12px',
        padding: '7px 12px',
      }}
    >
      Wir verwenden Cookies, um die Website sicher zu betreiben und Funktionen
      bereitzustellen. Details finden Sie in unserer{' '}
      <a
        href={PRIVACY_POLICY_URL}
        target="_blank"
        rel="noreferrer"
        style={{ color: '#9fe8ff', textDecoration: 'underline' }}
      >
        Datenschutzerklaerung
      </a>
      .
    </CookieConsent>
  );
};

export default CookieBanner;
