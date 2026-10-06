import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';
import { Form } from 'react-bootstrap';
import { X } from 'react-bootstrap-icons';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { PRIVACY_POLICY_URL } from './consent';
import { useConsent } from './ConsentProvider';

// Accept and reject deliberately share one style: regulators (EDPB cookie
// banner taskforce, German DSK) require both options to be equally prominent.
const choiceButtonStyle: CSSProperties = {
  flex: '1 1 0',
  minHeight: 38,
  padding: '0 16px',
  border: 'none',
  borderRadius: 'var(--progeo-radius-pill)',
  background: 'var(--progeo-blue)',
  color: 'var(--progeo-white)',
  fontFamily: 'inherit',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

const secondaryButtonStyle: CSSProperties = {
  ...choiceButtonStyle,
  flex: '1 1 100%',
  background: 'transparent',
  color: 'var(--progeo-blue)',
  boxShadow: 'inset 0 0 0 1.5px var(--progeo-blue)',
};

const categoryStyle: CSSProperties = {
  background: 'var(--progeo-surface)',
  borderRadius: 12,
  padding: '10px 12px',
};

const categoryDescStyle: CSSProperties = {
  margin: '4px 0 0',
  fontSize: 12,
  color: '#6E6868',
};

/**
 * Privacy banner shown until the user has decided, and again whenever the
 * settings are reopened (`useConsent().openSettings()`, e.g. from the top bar).
 * Nothing optional is loaded before an explicit opt-in.
 */
const CookieBanner = () => {
  const { t } = useTranslation();
  const { consent, settingsOpen, acceptAll, rejectAll, save, closeSettings } =
    useConsent();
  const visible = consent === null || settingsOpen;

  const [showDetails, setShowDetails] = useState(false);
  const [mapsChoice, setMapsChoice] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<Element | null>(null);
  const titleId = useId();
  const descId = useId();
  const mapsSwitchId = useId();

  // Each time the banner opens: mirror the stored choice, move focus into the
  // dialog so screen readers announce it, and hand focus back when it closes.
  useEffect(() => {
    if (!visible) {
      return undefined;
    }
    setShowDetails(settingsOpen);
    setMapsChoice(consent?.categories.externalMaps ?? false);
    returnFocusRef.current = document.activeElement;
    dialogRef.current?.focus();
    return () => {
      const previous = returnFocusRef.current;
      if (previous instanceof HTMLElement && previous.isConnected) {
        previous.focus();
      }
    };
    // Only react to opening/closing - not to the consent update that closes it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  if (!visible) {
    return null;
  }

  // Escape only dismisses a reopened settings dialog; a first-time visitor has
  // to make an actual choice (dismissing must not be mistaken for consent).
  const canDismiss = consent !== null;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && canDismiss) {
      event.stopPropagation();
      closeSettings();
    }
  };

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      aria-describedby={descId}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      style={{
        position: 'fixed',
        right: 16,
        bottom: 16,
        width: 'min(440px, calc(100vw - 32px))',
        maxHeight: 'calc(100vh - 32px)',
        overflowY: 'auto',
        background: 'var(--progeo-panel-bg)',
        color: 'var(--progeo-blue)',
        borderRadius: 'var(--progeo-radius-panel)',
        boxShadow: '0 14px 40px rgba(11, 54, 89, .25)',
        padding: 20,
        fontSize: 13,
        lineHeight: 1.5,
        zIndex: 2000,
        outline: 'none',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <h2
          id={titleId}
          style={{ flex: 1, margin: 0, fontSize: 16, fontWeight: 700 }}
        >
          {t('consent_title')}
        </h2>
        {canDismiss && (
          <button
            type="button"
            onClick={closeSettings}
            aria-label={t('consent_close')}
            title={t('consent_close')}
            style={{
              border: 'none',
              background: 'transparent',
              color: 'var(--progeo-blue)',
              padding: 0,
              lineHeight: 0,
              cursor: 'pointer',
            }}
          >
            <X size={22} />
          </button>
        )}
      </div>

      <p id={descId} style={{ margin: '8px 0 14px' }}>
        {t('consent_intro')}{' '}
        <Link
          to={PRIVACY_POLICY_URL}
          style={{ color: 'var(--progeo-blue)', fontWeight: 600 }}
        >
          {t('consent_privacy_policy')}
        </Link>
      </p>

      {showDetails && (
        <ul
          style={{
            listStyle: 'none',
            padding: 0,
            margin: '0 0 14px',
            display: 'grid',
            gap: 8,
          }}
        >
          <li style={categoryStyle}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                gap: 8,
              }}
            >
              <strong>{t('consent_necessary_title')}</strong>
              <span style={{ fontSize: 12, color: '#6E6868' }}>
                {t('consent_always_on')}
              </span>
            </div>
            <p style={categoryDescStyle}>{t('consent_necessary_desc')}</p>
          </li>
          <li style={categoryStyle}>
            <Form.Check
              type="switch"
              id={mapsSwitchId}
              checked={mapsChoice}
              onChange={(event) => setMapsChoice(event.target.checked)}
              label={<strong>{t('consent_maps_title')}</strong>}
              aria-describedby={`${mapsSwitchId}-desc`}
              style={{ marginBottom: 0 }}
            />
            <p id={`${mapsSwitchId}-desc`} style={categoryDescStyle}>
              {t('consent_maps_desc')}
            </p>
          </li>
        </ul>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <button type="button" onClick={rejectAll} style={choiceButtonStyle}>
          {t('consent_reject')}
        </button>
        <button type="button" onClick={acceptAll} style={choiceButtonStyle}>
          {t('consent_accept_all')}
        </button>
        {showDetails ? (
          <button
            type="button"
            onClick={() => save({ externalMaps: mapsChoice })}
            style={secondaryButtonStyle}
          >
            {t('consent_save')}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setShowDetails(true)}
            style={secondaryButtonStyle}
          >
            {t('consent_customize')}
          </button>
        )}
      </div>
    </div>
  );
};

export default CookieBanner;
