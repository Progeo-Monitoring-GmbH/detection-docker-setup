import { useState } from 'react';
import { MapContainer, useMapEvents } from 'react-leaflet';
import { useTranslation } from 'react-i18next';
import { GeoAltFill } from 'react-bootstrap-icons';
import { useConsent } from '../components/privacy/ConsentProvider';
import MapConsentNotice from '../components/privacy/MapConsentNotice';
import { MapBaseTiles, MapLayerSwitch } from '../components/ui/MapBaseLayer';
import { useMapBaseLayer } from '../components/ui/mapLayers';
import { useWheelHint, WheelZoomHint } from '../components/ui/wheelZoom';
import { CtrlWheelZoom } from './LocationsMapControls';

// react-leaflet's prop types don't resolve under this setup (see LocationStandortPanel).
/* eslint-disable @typescript-eslint/no-explicit-any */
const AnyMapContainer = MapContainer as any;
const AnyCtrlWheelZoom = CtrlWheelZoom as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

export type LatLng = { lat: number; lng: number };

/** Where the map opens without a position: Germany as a whole. */
export const NO_POSITION_START: LatLng & { zoom: number } = {
  lat: 51.1657,
  lng: 10.4515,
  zoom: 6,
};

/** Metres between two positions (haversine) - how far the pin was moved. */
export const distanceMeters = (a: LatLng, b: LatLng) => {
  const toRad = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h)));
};

/** "12 m" / "1,4 km" in the user's number format. */
export const formatDistance = (meters: number) =>
  meters < 1000
    ? `${Math.round(meters)} m`
    : `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(meters / 1000)} km`;

/** Six decimals: ~0.1 m - more than a GPS position needs. */
const roundCoordinate = (value: number) => Math.round(value * 1e6) / 1e6;

/** Follows the map's center while it is dragged or zoomed. */
const CenterTracker = ({ onMove }: { onMove: (center: LatLng) => void }) => {
  const map = useMapEvents({
    move: () => {
      const center = map.getCenter();
      onMove({ lat: center.lat, lng: center.lng });
    },
  });
  return null;
};

/**
 * Staff: the position corrected on the map - drag the map (or use the
 * arrow keys) until the pin in its middle sits on the building, zoom with
 * the buttons, a double click or Ctrl + wheel; "Save" stores the pin's
 * position (the same as typing it in).
 */
const StandortPositionPicker = ({
  start,
  zoom = 18,
  saving,
  onSave,
  onCancel,
}: {
  /** The position now; null: none yet (the map opens on Germany). */
  start: LatLng | null;
  zoom?: number;
  saving: boolean;
  onSave: (latitude: number, longitude: number) => void;
  onCancel: () => void;
}) => {
  const { t } = useTranslation();
  const { allows } = useConsent();
  const [baseLayer, setBaseLayer] = useMapBaseLayer();
  const [wheelHint, showWheelHint] = useWheelHint();
  const opening = start ?? NO_POSITION_START;
  const [center, setCenter] = useState<LatLng>({
    lat: opening.lat,
    lng: opening.lng,
  });
  const moved = start ? distanceMeters(start, center) : null;
  // Less than a metre is no correction.
  const unchanged = moved !== null && moved < 1;

  return (
    <div className="standort-picker" data-testid="standort-picker">
      {/* The map above, the bar below it - the map's attribution stays visible. */}
      <div className="standort-picker-map">
        <AnyMapContainer
          center={[opening.lat, opening.lng]}
          zoom={start ? zoom : NO_POSITION_START.zoom}
          className="standort-leaflet"
          // Ctrl + wheel only (CtrlWheelZoom) - the plain wheel scrolls the page.
          scrollWheelZoom={false}
          dragging
          zoomControl
          doubleClickZoom
          keyboard
        >
          {allows('externalMaps') && <MapBaseTiles layer={baseLayer} />}
          <CenterTracker onMove={setCenter} />
          <AnyCtrlWheelZoom onPlain={showWheelHint} />
        </AnyMapContainer>
        {/* The new position: the map's middle - the pin's tip on it. */}
        <GeoAltFill
          className="standort-picker-pin"
          size={34}
          aria-hidden
          data-testid="standort-picker-pin"
        />
        <WheelZoomHint
          visible={wheelHint}
          testId="standort-picker-wheel-hint"
        />
        {allows('externalMaps') && (
          <MapLayerSwitch value={baseLayer} onChange={setBaseLayer} />
        )}
        <MapConsentNotice />
      </div>
      <div className="standort-picker-bar" data-testid="standort-picker-bar">
        <div className="standort-picker-info">
          <span className="standort-picker-hint">
            {t('objekt_position_pick_hint')}
          </span>
          <span
            className="standort-picker-coords"
            data-testid="standort-picker-coords"
          >
            {roundCoordinate(center.lat).toFixed(6)},{' '}
            {roundCoordinate(center.lng).toFixed(6)}
            {moved !== null &&
              !unchanged &&
              ` · ${t('objekt_position_pick_moved', { distance: formatDistance(moved) })}`}
          </span>
        </div>
        <div className="standort-picker-actions">
          <button
            type="button"
            className="standort-picker-cancel"
            onClick={onCancel}
            disabled={saving}
            data-testid="standort-picker-cancel"
          >
            {t('objekt_position_cancel')}
          </button>
          <button
            type="button"
            className="standort-position-save"
            onClick={() =>
              onSave(roundCoordinate(center.lat), roundCoordinate(center.lng))
            }
            disabled={saving || unchanged}
            data-testid="standort-picker-save"
          >
            {saving ? t('ui_loading') : t('objekt_position_save')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default StandortPositionPicker;
