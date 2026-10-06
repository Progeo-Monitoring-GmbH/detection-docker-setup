import { useTranslation } from 'react-i18next';
import { useConsent } from './ConsentProvider';

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
      style={{
        position: 'absolute',
        left: '50%',
        top: placement === 'top' ? 12 : '50%',
        transform:
          placement === 'top' ? 'translateX(-50%)' : 'translate(-50%, -50%)',
        width: 'min(340px, calc(100% - 24px))',
        // Above Leaflet's panes and controls (z-index up to 1000).
        zIndex: 1001,
        background: 'var(--progeo-surface)',
        color: 'var(--progeo-blue)',
        borderRadius: 14,
        boxShadow: '0 10px 30px rgba(11, 54, 89, .2)',
        padding: 12,
        fontSize: 12.5,
        lineHeight: 1.45,
        textAlign: 'center',
      }}
    >
      <p style={{ margin: '0 0 10px' }}>{t('consent_maps_blocked')}</p>
      <div
        style={{
          display: 'flex',
          gap: 8,
          justifyContent: 'center',
          flexWrap: 'wrap',
        }}
      >
        <button
          type="button"
          onClick={() => save({ externalMaps: true })}
          style={{
            height: 32,
            padding: '0 14px',
            border: 'none',
            borderRadius: 'var(--progeo-radius-pill)',
            background: 'var(--progeo-blue)',
            color: 'var(--progeo-white)',
            fontFamily: 'inherit',
            fontSize: 12.5,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          {t('consent_maps_enable')}
        </button>
        <button
          type="button"
          onClick={openSettings}
          style={{
            height: 32,
            padding: '0 10px',
            border: 'none',
            background: 'transparent',
            color: 'var(--progeo-blue)',
            fontFamily: 'inherit',
            fontSize: 12.5,
            textDecoration: 'underline',
            cursor: 'pointer',
          }}
        >
          {t('consent_open_settings')}
        </button>
      </div>
    </div>
  );
};

export default MapConsentNotice;
