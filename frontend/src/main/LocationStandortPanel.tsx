import { CircleMarker, MapContainer, TileLayer } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import { useTranslation } from 'react-i18next';
import { Geo } from 'react-bootstrap-icons';
import PanelCard from '../components/ui/kit/PanelCard';
import type { LocationDetail } from './locationTypes';
import { formatDateTime } from './dateFormat';

// react-leaflet@5's shipped prop types don't resolve `center`/`zoom`/
// `attribution`/`radius` etc. under this project's TS setup (every other
// consumer is untyped .jsx, e.g. LocationsMapView.jsx, so this has never
// surfaced before). Cast rather than fight the library's types.
/* eslint-disable @typescript-eslint/no-explicit-any */
const AnyMapContainer = MapContainer as any;
const AnyTileLayer = TileLayer as any;
const AnyCircleMarker = CircleMarker as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

const TILE_URL =
  import.meta.env.VITE_MAP_TILE_URL ||
  'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';

type LocationStandortPanelProps = {
  location: LocationDetail | null;
};

const hasCoordinates = (
  location: LocationDetail | null,
): location is LocationDetail & { latitude: number; longitude: number } =>
  typeof location?.latitude === 'number' &&
  Number.isFinite(location.latitude) &&
  typeof location?.longitude === 'number' &&
  Number.isFinite(location.longitude);

/** The mockup's "Standort" side panel: a single-marker map, or a placeholder when no coordinates are set. */
const LocationStandortPanel = ({ location }: LocationStandortPanelProps) => {
  const { t } = useTranslation();

  return (
    <PanelCard title={t('objekt_standort_title')}>
      <div
        style={{
          aspectRatio: '4 / 3',
          background: 'var(--progeo-surface)',
          borderRadius: 13,
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        {hasCoordinates(location) ? (
          <AnyMapContainer
            center={[location.latitude, location.longitude]}
            zoom={15}
            style={{ height: '100%', width: '100%' }}
            scrollWheelZoom={false}
            dragging={false}
            zoomControl={false}
            doubleClickZoom={false}
          >
            <AnyTileLayer attribution="&copy; OpenStreetMap contributors" url={TILE_URL} />
            <AnyCircleMarker
              center={[location.latitude, location.longitude]}
              radius={7}
              pathOptions={{ color: '#EB633B', fillColor: '#EB633B', fillOpacity: 0.9 }}
            />
          </AnyMapContainer>
        ) : (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              textAlign: 'center',
              fontSize: 12,
              color: '#8B8383',
              padding: 12,
            }}
          >
            <div>
              <Geo size={26} color="#EB633B" />
              <div style={{ marginTop: 6 }}>{t('objekt_standort_placeholder')}</div>
            </div>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 1, marginTop: 14 }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: 12,
            padding: '8px 2px',
            fontSize: 13.5,
          }}
        >
          <span style={{ color: '#6E6868' }}>{t('objekt_fact_devices')}</span>
          <span style={{ fontWeight: 500 }}>{location?.device_count ?? '–'}</span>
        </div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: 12,
            padding: '8px 2px',
            fontSize: 13.5,
          }}
        >
          <span style={{ color: '#6E6868' }}>{t('objekt_fact_last_measurement')}</span>
          <span style={{ fontWeight: 500 }}>
            {formatDateTime(location?.last_measurement_at)}
          </span>
        </div>
      </div>
    </PanelCard>
  );
};

export default LocationStandortPanel;
