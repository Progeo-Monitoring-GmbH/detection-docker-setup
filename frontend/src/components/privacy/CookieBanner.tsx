import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import { Form } from 'react-bootstrap';
import { X } from 'react-bootstrap-icons';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { PRIVACY_POLICY_URL } from './consent';
import { useConsent } from './ConsentProvider';
import { repeatedTestId, testId } from '../../testIds';
import './CookieBanner.css';

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
  category,
}: {
  title: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** For test ids: the item "cookie-banner-category" is keyed by it, the switch is "cookie-banner-<category>-switch". */
  category: string;
}) => {
  const id = useId();
  return (
    <li className="cookie-banner__category" {...repeatedTestId('cookie-banner-category', category)}>
      <Form.Check
        type="switch"
        id={id}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        label={<strong>{title}</strong>}
        aria-describedby={`${id}-desc`}
        className="cookie-banner__switch"
        data-testid={testId('cookie-banner', category, 'switch')}
      />
      <p id={`${id}-desc`} className="cookie-banner__category-desc">
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
      data-testid="cookie-banner"
    >
      <div className="cookie-banner__body">
        <div className="cookie-banner__head">
          <h2
            id={titleId}
            className="cookie-banner__title"
          >
            {t('consent_title')}
          </h2>
          {canDismiss && (
            <button
              type="button"
              onClick={closeSettings}
              aria-label={t('consent_close')}
              title={t('consent_close')}
              className="cookie-banner__close"
              data-testid="cookie-banner-close"
            >
              <X size={22} />
            </button>
          )}
        </div>

        <p id={descId} className="cookie-banner__intro">
          {t('consent_intro')}{' '}
          <Link
            to={PRIVACY_POLICY_URL}
            className="cookie-banner__link"
            data-testid="cookie-banner-privacy-link"
          >
            {t('consent_privacy_policy')}
          </Link>
        </p>

        {showDetails && (
          <ul className="cookie-banner__categories" data-testid="cookie-banner-categories">
            <li className="cookie-banner__category" {...repeatedTestId('cookie-banner-category', 'necessary')}>
              <div className="cookie-banner__category-head">
                <strong>{t('consent_necessary_title')}</strong>
                <span className="cookie-banner__always-on">
                  {t('consent_always_on')}
                </span>
              </div>
              <p className="cookie-banner__category-desc">{t('consent_necessary_desc')}</p>
            </li>
            <ConsentSwitch
              title={t('consent_maps_title')}
              description={t('consent_maps_desc')}
              checked={mapsChoice}
              onChange={setMapsChoice}
              category="maps"
            />
            <ConsentSwitch
              title={t('consent_stats_title')}
              description={t('consent_stats_desc')}
              checked={statsChoice}
              onChange={setStatsChoice}
              category="statistics"
            />
          </ul>
        )}
      </div>

      <div className="cookie-banner__actions">
        <button type="button" onClick={rejectAll} className="cookie-banner__choice" data-testid="cookie-banner-reject">
          {t('consent_reject')}
        </button>
        <button type="button" onClick={acceptAll} className="cookie-banner__choice" data-testid="cookie-banner-accept">
          {t('consent_accept_all')}
        </button>
        {showDetails ? (
          <button
            type="button"
            onClick={() => save({ externalMaps: mapsChoice, statistics: statsChoice })}
            className="cookie-banner__choice cookie-banner__choice--secondary"
            data-testid="cookie-banner-save"
          >
            {t('consent_save')}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setShowDetails(true)}
            className="cookie-banner__choice cookie-banner__choice--secondary"
            data-testid="cookie-banner-customize"
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
