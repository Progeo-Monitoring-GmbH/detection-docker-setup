import { useCallback, useState } from 'react';

/**
 * Base layers of the portal's Leaflet maps (Objekt tab "Standort", /map/).
 * Every source here is named in the privacy policy (externe Kartendienste:
 * OpenStreetMap, Esri ArcGIS Online) and is only loaded with the
 * `externalMaps` consent - add a new provider there before adding it here.
 */
export type MapBaseLayer = 'satellite' | 'hybrid' | 'street';

export type MapTileSource = { url: string; attribution: string; maxNativeZoom?: number };

const ESRI_ATTRIBUTION =
  'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community';
const OSM_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors';

const ESRI_IMAGERY: MapTileSource = {
  url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  attribution: ESRI_ATTRIBUTION,
  maxNativeZoom: 19,
};
/** Transparent place names and borders on top of the imagery ("hybrid"). */
const ESRI_LABELS: MapTileSource = {
  url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
  attribution: ESRI_ATTRIBUTION,
  maxNativeZoom: 19,
};
const OSM_STREET: MapTileSource = {
  url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  attribution: OSM_ATTRIBUTION,
  maxNativeZoom: 19,
};

export const MAP_BASE_LAYERS: MapBaseLayer[] = ['satellite', 'hybrid', 'street'];
export const DEFAULT_MAP_BASE_LAYER: MapBaseLayer = 'satellite';

export const MAP_BASE_LAYER_LABEL_KEYS: Record<MapBaseLayer, string> = {
  satellite: 'map_layer_satellite',
  hybrid: 'map_layer_hybrid',
  street: 'map_layer_street',
};

/**
 * VITE_MAP_TILE_URL points every map at one own tile server (offline
 * deployments): then that is the only layer and there is nothing to switch.
 */
export const customTileUrl = (): string | null =>
  (import.meta.env.VITE_MAP_TILE_URL as string | undefined) || null;

/** The tile layers to stack for `layer`, bottom first. */
export const tileSourcesFor = (
  layer: MapBaseLayer,
  customUrl: string | null = customTileUrl(),
): MapTileSource[] => {
  if (customUrl) {
    return [{ url: customUrl, attribution: '' }];
  }
  if (layer === 'street') {
    return [OSM_STREET];
  }
  if (layer === 'hybrid') {
    return [ESRI_IMAGERY, ESRI_LABELS];
  }
  return [ESRI_IMAGERY];
};

/** Per browser: the base layer last picked on any map. */
export const MAP_BASE_LAYER_KEY = 'progeo.map.baseLayer';

export const readMapBaseLayer = (): MapBaseLayer => {
  try {
    const stored = localStorage.getItem(MAP_BASE_LAYER_KEY);
    return MAP_BASE_LAYERS.includes(stored as MapBaseLayer)
      ? (stored as MapBaseLayer)
      : DEFAULT_MAP_BASE_LAYER;
  } catch {
    return DEFAULT_MAP_BASE_LAYER;
  }
};

export const storeMapBaseLayer = (layer: MapBaseLayer) => {
  try {
    localStorage.setItem(MAP_BASE_LAYER_KEY, layer);
  } catch {
    // Storage blocked: the choice lasts until the next reload.
  }
};

/** The chosen base layer (satellite by default), remembered per browser. */
export const useMapBaseLayer = (): [MapBaseLayer, (layer: MapBaseLayer) => void] => {
  const [layer, setLayer] = useState<MapBaseLayer>(readMapBaseLayer);
  const choose = useCallback((next: MapBaseLayer) => {
    setLayer(next);
    storeMapBaseLayer(next);
  }, []);
  return [layer, choose];
};
