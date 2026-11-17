import { useState } from 'react';
import { CircleMarker, MapContainer } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import { useTranslation } from 'react-i18next';
import { ArrowRepeat, Geo } from 'react-bootstrap-icons';
import PanelCard from '../components/ui/kit/PanelCard';
import LabeledInput from '../components/ui/kit/LabeledInput';
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
  /**
   * Staff: look the position up again from the address although one is set,
   * and type latitude/longitude in by hand. Absent for everyone else.
   */
  staffPosition?: {
    onRegeocode: () => void;
    onSave: (latitude: number, longitude: number) => void;
    saving: boolean;
  };
};

/**
 * A typed coordinate: the number (comma or point as decimal separator),
 * null when empty, NaN when it isn't one or lies outside +-`limit`.
 */
export const parseCoordinate = (value: string, limit: number): number | null => {
  const trimmed = value.trim().replace(',', '.');
  if (!trimmed) {
    return null;
  }
  const number = /^[-+]?\d+(\.\d+)?$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  return Math.abs(number) <= limit ? number : Number.NaN;
};

const coordinateText = (value: number | null | undefined) =>
  typeof value === 'number' && Number.isFinite(value) ? String(value) : '';

/** Staff: the position by hand, and "fetch again from the address". */
const StaffPositionForm = ({
  location,
  staffPosition,
  geocoding,
  geocodeBlockedReason,
}: {
  location: LocationDetail | null;
  staffPosition: NonNullable<LocationStandortPanelProps['staffPosition']>;
  geocoding: boolean;
  geocodeBlockedReason?: string;
}) => {
  const { t } = useTranslation();
  const [latitude, setLatitude] = useState(coordinateText(location?.latitude));
  const [longitude, setLongitude] = useState(coordinateText(location?.longitude));

  const lat = parseCoordinate(latitude, 90);
  const lng = parseCoordinate(longitude, 180);
  const invalid = lat == null || lng == null || Number.isNaN(lat) || Number.isNaN(lng);
  const unchanged =
    latitude === coordinateText(location?.latitude) && longitude === coordinateText(location?.longitude);

  return (
    <div className="standort-position" data-testid="standort-position">
      <div className="standort-position-head">
        <span className="standort-position-title">{t('objekt_position_title')}</span>
        <button
          type="button"
          className="standort-position-regeocode"
          onClick={staffPosition.onRegeocode}
          disabled={geocoding || Boolean(geocodeBlockedReason)}
          title={geocodeBlockedReason ?? t('objekt_regeocode_hint')}
          data-testid="standort-regeocode"
        >
          <ArrowRepeat aria-hidden size={13} />
          {geocoding ? t('ui_loading') : t('objekt_regeocode')}
        </button>
      </div>
      <div className="standort-position-grid">
        <LabeledInput
          testId="standort-latitude"
          label={t('objekt_latitude')}
          value={latitude}
          onChange={setLatitude}
        />
        <LabeledInput
          testId="standort-longitude"
          label={t('objekt_longitude')}
          value={longitude}
          onChange={setLongitude}
        />
        <button
          type="button"
          className="standort-position-save"
          disabled={invalid || unchanged || staffPosition.saving}
          onClick={() => !invalid && staffPosition.onSave(lat as number, lng as number)}
          data-testid="standort-position-save"
        >
          {staffPosition.saving ? t('ui_loading') : t('objekt_position_save')}
        </button>
      </div>
      {!unchanged && invalid && (
        <div className="standort-position-invalid" data-testid="standort-position-invalid">
          {t('objekt_position_invalid')}
        </div>
      )}
    </div>
  );
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
  staffPosition,
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

      {staffPosition && (
        <StaffPositionForm
          // A new position from outside (geocoded, saved) replaces the typed one.
          key={`${location?.latitude},${location?.longitude}`}
          location={location}
          staffPosition={staffPosition}
          geocoding={geocoding}
          geocodeBlockedReason={geocodeBlockedReason}
        />
      )}
    </PanelCard>
  );
};

export default LocationStandortPanel;
