import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import { Form } from 'react-bootstrap';
import { X } from 'react-bootstrap-icons';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { PRIVACY_POLICY_URL } from './consent';
import { useConsent } from './ConsentProvider';
import './CookieBanner.css';

// Accept and reject deliberately share one style: regulators (EDPB cookie
// banner taskforce, German DSK) require both options to be equally prominent.
const choiceButtonStyle: CSSProperties = {
  // Wraps to one button per row when two don't fit side by side.
  flex: '1 1 140px',
  minHeight: 38,
  padding: '6px 16px',
  border: 'none',
  borderRadius: 'var(--progeo-radius-pill)',
  background: 'var(--progeo-blue)',
  color: 'var(--progeo-white)',
  fontFamily: 'inherit',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
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

/** Moves focus into the dialog while it is shown, so screen readers announce
 * it, and hands focus back to where it was when it closes. */
const useDialogFocus = (dialogRef: RefObject<HTMLDivElement | null>) => {
  useEffect(() => {
    const previous = document.activeElement;
    dialogRef.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) {
        previous.focus();
      }
    };
  }, [dialogRef]);
};

/** An optional consent category with its switch and description. */
const ConsentSwitch = ({
  title,
  description,
  checked,
  onChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) => {
  const id = useId();
  return (
    <li style={categoryStyle}>
      <Form.Check
        type="switch"
        id={id}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        label={<strong>{title}</strong>}
        aria-describedby={`${id}-desc`}
        style={{ marginBottom: 0 }}
      />
      <p id={`${id}-desc`} style={categoryDescStyle}>
        {description}
      </p>
    </li>
  );
};

/**
 * The banner's dialog, mounted each time it opens - so it starts from the
 * stored choice (details shown when the settings were reopened).
 */
const CookieDialog = () => {
  const { t } = useTranslation();
  const { consent, settingsOpen, acceptAll, rejectAll, save, closeSettings } =
    useConsent();
  const [showDetails, setShowDetails] = useState(settingsOpen);
  const [mapsChoice, setMapsChoice] = useState(consent?.categories.externalMaps ?? false);
  const [statsChoice, setStatsChoice] = useState(consent?.categories.statistics ?? false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  useDialogFocus(dialogRef);

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
      className="cookie-banner"
    >
      <div className="cookie-banner__body">
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

        <p id={descId} style={{ margin: '8px 0 0' }}>
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
              margin: '14px 0 0',
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
            <ConsentSwitch
              title={t('consent_maps_title')}
              description={t('consent_maps_desc')}
              checked={mapsChoice}
              onChange={setMapsChoice}
            />
            <ConsentSwitch
              title={t('consent_stats_title')}
              description={t('consent_stats_desc')}
              checked={statsChoice}
              onChange={setStatsChoice}
            />
          </ul>
        )}
      </div>

      <div className="cookie-banner__actions">
        <button type="button" onClick={rejectAll} style={choiceButtonStyle}>
          {t('consent_reject')}
        </button>
        <button type="button" onClick={acceptAll} style={choiceButtonStyle}>
          {t('consent_accept_all')}
        </button>
        {showDetails ? (
          <button
            type="button"
            onClick={() => save({ externalMaps: mapsChoice, statistics: statsChoice })}
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

/**
 * Privacy banner shown until the user has decided, and again whenever the
 * settings are reopened (`useConsent().openSettings()`, e.g. from the top bar).
 * Nothing optional is loaded before an explicit opt-in.
 */
const CookieBanner = () => {
  const { consent, settingsOpen } = useConsent();
  return consent === null || settingsOpen ? <CookieDialog /> : null;
};

export default CookieBanner;
