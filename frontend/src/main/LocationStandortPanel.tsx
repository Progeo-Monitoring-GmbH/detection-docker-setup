import { CircleMarker, MapContainer } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import { useTranslation } from 'react-i18next';
import { Geo } from 'react-bootstrap-icons';
import PanelCard from '../components/ui/kit/PanelCard';
import type { LocationDetail } from './locationTypes';
import { formatDate, formatRelativeTime } from './dateFormat';
import { useConsent } from '../components/privacy/ConsentProvider';
import MapConsentNotice from '../components/privacy/MapConsentNotice';
import { MapBaseTiles, MapLayerSwitch } from '../components/ui/MapBaseLayer';
import { useMapBaseLayer } from '../components/ui/mapLayers';
import './LocationStandortPanel.css';

// react-leaflet@5's shipped prop types don't resolve `center`/`zoom`/
// `attribution`/`radius` etc. under this project's TS setup (every other
// consumer is untyped .jsx, e.g. LocationsMapView.jsx, so this has never
// surfaced before). Cast rather than fight the library's types.
/* eslint-disable @typescript-eslint/no-explicit-any */
const AnyMapContainer = MapContainer as any;
const AnyCircleMarker = CircleMarker as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

type LocationStandortPanelProps = {
  location: LocationDetail | null;
  /** Shows a "fetch GPS position" button while no coordinates are set. */
  onGeocode?: () => void;
  geocoding?: boolean;
  /** Disables that button, with this as the hint. */
  geocodeBlockedReason?: string;
};

/** A usable position - 0/0 is what old imports wrote for "unknown" (backend has_position). */
const hasCoordinates = (
  location: LocationDetail | null,
): location is LocationDetail & { latitude: number; longitude: number } =>
  typeof location?.latitude === 'number' &&
  Number.isFinite(location.latitude) &&
  typeof location?.longitude === 'number' &&
  Number.isFinite(location.longitude) &&
  !(location.latitude === 0 && location.longitude === 0);

/** The mockup's "Standort" side panel: a single-marker map, or a placeholder when no coordinates are set. */
const LocationStandortPanel = ({
  location,
  onGeocode,
  geocoding = false,
  geocodeBlockedReason,
}: LocationStandortPanelProps) => {
  const { t } = useTranslation();
  const { allows } = useConsent();
  // Satellite by default - the building is what matters here.
  const [baseLayer, setBaseLayer] = useMapBaseLayer();

  return (
    <PanelCard title={t('objekt_standort_title')} testId="standort">
      <div className="standort-map" data-testid="standort-map">
        {hasCoordinates(location) ? (
          <>
            {/* Leaflet reads `center` only once: a new position (address
                saved, re-geocoded) remounts the map around it. */}
            <AnyMapContainer
              key={`${location.latitude},${location.longitude}`}
              center={[location.latitude, location.longitude]}
              zoom={17}
              className="standort-leaflet"
              scrollWheelZoom={false}
              dragging={false}
              zoomControl={false}
              doubleClickZoom={false}
            >
              {allows('externalMaps') && <MapBaseTiles layer={baseLayer} />}
              <AnyCircleMarker
                center={[location.latitude, location.longitude]}
                radius={7}
                pathOptions={{
                  color: '#EB633B',
                  fillColor: '#EB633B',
                  fillOpacity: 0.9,
                }}
              />
            </AnyMapContainer>
            {allows('externalMaps') && (
              <MapLayerSwitch value={baseLayer} onChange={setBaseLayer} />
            )}
            <MapConsentNotice />
          </>
        ) : (
          <div className="standort-placeholder" data-testid="standort-placeholder">
            <div>
              <Geo size={26} color="#EB633B" />
              <div className="standort-placeholder-text">
                {t('objekt_standort_placeholder')}
              </div>
              {onGeocode && (
                <button
                  type="button"
                  onClick={onGeocode}
                  data-testid="standort-geocode"
                  disabled={geocoding || Boolean(geocodeBlockedReason)}
                  title={geocodeBlockedReason}
                  className={`standort-geocode${geocodeBlockedReason ? ' standort-geocode--blocked' : ''}`}
                >
                  {geocoding ? t('ui_loading') : t('objekt_geocode')}
                </button>
              )}
              {onGeocode && geocodeBlockedReason && (
                <div className="standort-placeholder-text" data-testid="standort-geocode-blocked">
                  {geocodeBlockedReason}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="standort-facts" data-testid="standort-facts">
        <div className="standort-fact">
          <span className="standort-fact-label">{t('objekt_fact_devices')}</span>
          <span className="standort-fact-value" data-testid="standort-device-count">
            {location?.device_count ?? '–'}
          </span>
        </div>
        <div className="standort-fact">
          <span className="standort-fact-label">
            {t('objekt_fact_last_measurement')}
          </span>
          <span
            className="standort-fact-value"
            data-testid="standort-last-measurement"
            title={formatDate(location?.last_measurement_at, 'dateTime')}
          >
            {formatRelativeTime(location?.last_measurement_at)}
          </span>
        </div>
      </div>
    </PanelCard>
  );
};

export default LocationStandortPanel;
