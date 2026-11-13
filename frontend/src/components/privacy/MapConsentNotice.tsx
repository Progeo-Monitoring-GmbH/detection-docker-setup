import { useTranslation } from 'react-i18next';
import { useConsent } from './ConsentProvider';
import './MapConsentNotice.css';

type MapConsentNoticeProps = {
  /** 'top' keeps markers in the middle of large maps visible. */
  placement?: 'top' | 'center';
};

/**
 * Overlay for a map whose tile layer is withheld because the user has not
 * opted into external map services. Render it as a sibling of the
 * MapContainer inside a `position: relative` parent; renders nothing once
 * consent is given.
 */
const MapConsentNotice = ({ placement = 'center' }: MapConsentNoticeProps) => {
  const { t } = useTranslation();
  const { allows, save, openSettings } = useConsent();

  if (allows('externalMaps')) {
    return null;
  }

  return (
    <div
      role="note"
      className={
        placement === 'top'
          ? 'map-consent-notice map-consent-notice--top'
          : 'map-consent-notice'
      }
      data-testid="map-consent-notice"
    >
      <p className="map-consent-notice-text">{t('consent_maps_blocked')}</p>
      <div className="map-consent-notice-actions">
        <button
          type="button"
          // Only the maps - the statistics choice stays as it was.
          onClick={() => save({ externalMaps: true, statistics: allows('statistics') })}
          className="map-consent-notice-enable"
          data-testid="map-consent-notice-enable"
        >
          {t('consent_maps_enable')}
        </button>
        <button
          type="button"
          onClick={openSettings}
          className="map-consent-notice-settings"
          data-testid="map-consent-notice-settings"
        >
          {t('consent_open_settings')}
        </button>
      </div>
    </div>
  );
};

export default MapConsentNotice;
