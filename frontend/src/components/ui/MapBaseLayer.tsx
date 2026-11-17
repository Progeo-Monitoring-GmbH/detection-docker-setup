import { TileLayer } from 'react-leaflet';
import { ButtonGroup, Button } from 'react-bootstrap';
import { useTranslation } from 'react-i18next';
import {
  MAP_BASE_LAYERS,
  MAP_BASE_LAYER_LABEL_KEYS,
  customTileUrl,
  tileSourcesFor,
  type MapBaseLayer,
} from './mapLayers';
import './MapBaseLayer.css';

// react-leaflet@5's prop types don't resolve under this project's TS setup
// (see LocationStandortPanel.tsx).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const AnyTileLayer = TileLayer as any;

/**
 * The tile layer(s) of `layer` - render inside a MapContainer, and only with
 * the `externalMaps` consent. Keyed by URL, so a switch swaps the tiles.
 */
export const MapBaseTiles = ({ layer }: { layer: MapBaseLayer }) => (
  <>
    {tileSourcesFor(layer).map((source) => (
      <AnyTileLayer
        key={source.url}
        url={source.url}
        attribution={source.attribution}
        maxNativeZoom={source.maxNativeZoom}
        maxZoom={20}
      />
    ))}
  </>
);

type MapLayerSwitchProps = {
  value: MapBaseLayer;
  onChange: (layer: MapBaseLayer) => void;
};

/**
 * Satellite / hybrid / street switch, laid over the map's top-right corner.
 * Render it as a sibling of the MapContainer inside a `position: relative`
 * parent (clicks never reach the map). Nothing to switch with an own tile
 * server (VITE_MAP_TILE_URL).
 */
export const MapLayerSwitch = ({ value, onChange }: MapLayerSwitchProps) => {
  const { t } = useTranslation();
  if (customTileUrl()) {
    return null;
  }
  return (
    <ButtonGroup size="sm" className="map-layer-switch" aria-label={t('map_layer_label')} data-testid="map-layer-switch">
      {MAP_BASE_LAYERS.map((layer) => (
        <Button
          key={layer}
          variant="light"
          active={layer === value}
          aria-pressed={layer === value}
          onClick={() => onChange(layer)}
          data-testid={`map-layer-${layer}`}
        >
          {t(MAP_BASE_LAYER_LABEL_KEYS[layer])}
        </Button>
      ))}
    </ButtonGroup>
  );
};
