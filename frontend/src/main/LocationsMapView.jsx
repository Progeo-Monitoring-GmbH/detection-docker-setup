import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Badge,
  Card,
  Col,
  Container,
  Form,
  ListGroup,
  Row,
  Spinner,
} from 'react-bootstrap';
import {
  CircleMarker,
  MapContainer,
  TileLayer,
  Tooltip,
  useMap,
} from 'react-leaflet';
import 'leaflet/dist/leaflet.css';

import { useSnackbar } from 'notistack';

import { useAuth } from '../../hooks/CoreAuthProvider';
import axiosConfig from '../axiosConfig';
import { showErrorBar, showInfoBar } from '../components/ui/Snackbar.jsx';

const DEFAULT_CENTER = [51.1657, 10.4515];
const FLASH_DURATION_MS = 30000;

// Tile source: point VITE_MAP_TILE_URL at a local tile server (or another
// provider) for offline deployments - with the default Esri source the map
// page needs internet at runtime.
const TILE_URL =
  import.meta.env.VITE_MAP_TILE_URL ||
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

const hasCoordinates = (location) =>
  typeof location.latitude === 'number' &&
  Number.isFinite(location.latitude) &&
  typeof location.longitude === 'number' &&
  Number.isFinite(location.longitude);

const MapViewportController = ({ markers, selectedLocation }) => {
  const map = useMap();
  // Signature of the markers' spatial content only (id + coordinates). Websocket
  // updates that merely refresh metadata (e.g. last_measurement_at) create a new
  // `markers` array but keep the same signature, so the map is NOT re-fitted and
  // the user's zoom/position stays put.
  const fittedSignatureRef = useRef(null);
  // Once the user has panned or zoomed by hand, stop auto-fitting entirely so
  // even genuinely new markers don't yank the view away.
  const userInteractedRef = useRef(false);

  useEffect(() => {
    const markUserInteracted = () => {
      userInteractedRef.current = true;
    };
    const container = map.getContainer();
    map.on('dragstart', markUserInteracted);
    container.addEventListener('wheel', markUserInteracted, { passive: true });
    return () => {
      map.off('dragstart', markUserInteracted);
      container.removeEventListener('wheel', markUserInteracted);
    };
  }, [map]);

  useEffect(() => {
    const signature = markers
      .map((location) => `${location.id}:${location.latitude},${location.longitude}`)
      .sort()
      .join('|');

    if (userInteractedRef.current || signature === fittedSignatureRef.current) {
      return;
    }
    fittedSignatureRef.current = signature;

    if (!markers.length) {
      map.setView(DEFAULT_CENTER, 6);
      return;
    }

    const bounds = markers.map((location) => [
      location.latitude,
      location.longitude,
    ]);
    map.fitBounds(bounds, { padding: [32, 32], maxZoom: 16 });
  }, [map, markers]);

  useEffect(() => {
    if (!selectedLocation || !hasCoordinates(selectedLocation)) {
      return;
    }

    map.flyTo(
      [selectedLocation.latitude, selectedLocation.longitude],
      Math.max(map.getZoom(), 15),
      { duration: 0.35 },
    );
  }, [selectedLocation, map]);

  return null;
};

const ageInfoFromDate = (value) => {
  if (!value) {
    return {
      ageHours: null,
      state: 'no_data',
      label: 'No measurement yet',
      markerFill: '#a0a4ab',
      markerStroke: '#6c757d',
      badge: 'secondary',
    };
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return {
      ageHours: null,
      state: 'no_data',
      label: String(value),
      markerFill: '#a0a4ab',
      markerStroke: '#6c757d',
      badge: 'secondary',
    };
  }

  const ageHours = Math.max(
    0,
    (Date.now() - parsed.getTime()) / (1000 * 60 * 60),
  );
  if (ageHours <= 1) {
    return {
      ageHours,
      state: 'fresh_1h',
      label: '<= 1h',
      markerFill: '#2dc653',
      markerStroke: '#1b9e43',
      badge: 'success',
    };
  }

  if (ageHours <= 24) {
    return {
      ageHours,
      state: 'fresh_24h',
      label: `${Math.round(ageHours)}h`,
      markerFill: '#f7b801',
      markerStroke: '#d48e00',
      badge: 'warning',
    };
  }

  if (ageHours <= 72) {
    return {
      ageHours,
      state: 'late_72h',
      label: `${(ageHours / 24).toFixed(1)}d`,
      markerFill: '#f18701',
      markerStroke: '#c86d00',
      badge: 'warning',
    };
  }

  return {
    ageHours,
    state: 'stale',
    label: `${(ageHours / 24).toFixed(1)}d`,
    markerFill: '#d00000',
    markerStroke: '#9d0208',
    badge: 'danger',
  };
};

const STATE_FILTER_OPTIONS = [
  { value: 'all', label: 'All states' },
  { value: 'fresh_1h', label: 'Fresh (<=1h)' },
  { value: 'fresh_24h', label: 'Recent (<=24h)' },
  { value: 'late_72h', label: 'Late (<=72h)' },
  { value: 'stale', label: 'Stale (>72h)' },
  { value: 'no_data', label: 'No data yet' },
];

const STATE_TITLES = {
  fresh_1h: 'Fresh (<=1h)',
  fresh_24h: 'Recent (<=24h)',
  late_72h: 'Late (<=72h)',
  stale: 'Stale (>72h)',
  no_data: 'No data yet',
};

const buildLocationLabel = (location) => {
  const name = location.name || 'Unknown location';
  const project = location.project_id
    ? `#${location.project_id}`
    : 'No project';
  return `${project} - ${name}`;
};

const buildLocationMeta = (location) =>
  [location.address, location.plz, location.city].filter(Boolean).join(', ');

const blendHexColor = (fromHex, toHex, t) => {
  const clampT = Math.min(1, Math.max(0, t));
  const from = fromHex.replace('#', '');
  const to = toHex.replace('#', '');
  const fr = parseInt(from.slice(0, 2), 16);
  const fg = parseInt(from.slice(2, 4), 16);
  const fb = parseInt(from.slice(4, 6), 16);
  const tr = parseInt(to.slice(0, 2), 16);
  const tg = parseInt(to.slice(2, 4), 16);
  const tb = parseInt(to.slice(4, 6), 16);

  const rr = Math.round(fr + (tr - fr) * clampT)
    .toString(16)
    .padStart(2, '0');
  const rg = Math.round(fg + (tg - fg) * clampT)
    .toString(16)
    .padStart(2, '0');
  const rb = Math.round(fb + (tb - fb) * clampT)
    .toString(16)
    .padStart(2, '0');
  return `#${rr}${rg}${rb}`;
};

const LocationsMapView = () => {
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [hoveredId, setHoveredId] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [searchText, setSearchText] = useState('');
  const [stateFilter, setStateFilter] = useState('all');
  const [flashMarkers, setFlashMarkers] = useState({});
  const [flashTick, setFlashTick] = useState(Date.now());

  useEffect(() => {
    setLoading(true);
    void axiosConfig.perform_get(
      auth,
      '/v1/location/',
      (response) => {
        const items = response?.data || [];
        setRows(items);
        setLoading(false);
      },
      (error) => {
        const reason = error?.response?.data?.reason || error.message;
        showErrorBar(enqueueSnackbar, `Could not load locations: ${reason}`);
        setLoading(false);
      },
    );
  }, [auth, enqueueSnackbar]);

  useEffect(() => {
    const wsUrl = `${import.meta.env.VITE_WS_URL}/ws/commands/list`;
    const ws = new WebSocket(wsUrl);

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message?.type !== 'legacy_location_event') {
          return;
        }

        const location = message?.location;
        const projectId = message?.project_id;
        if (!location || !location.id) {
          showInfoBar(
            enqueueSnackbar,
            `Legacy measurement parsed for project ${projectId}`,
          );
          return;
        }

        const nowIso = message?.parsed_at || new Date().toISOString();
        setRows((prev) => {
          const index = prev.findIndex((row) => row.id === location.id);
          if (index === -1) {
            return [
              {
                ...location,
                last_measurement_at: nowIso,
              },
              ...prev,
            ];
          }

          const next = [...prev];
          next[index] = {
            ...next[index],
            ...location,
            last_measurement_at: nowIso,
          };
          return next;
        });

        setFlashMarkers((prev) => ({
          ...prev,
          [location.id]: Date.now() + FLASH_DURATION_MS,
        }));

        showInfoBar(
          enqueueSnackbar,
          `Live update: ${buildLocationLabel(location)} received new legacy measurement`,
        );
      } catch {
        // Ignore malformed websocket payloads.
      }
    };

    return () => {
      ws.close();
    };
  }, [enqueueSnackbar]);

  useEffect(() => {
    const hasActiveFlash = Object.values(flashMarkers).some(
      (expiresAt) => expiresAt > Date.now(),
    );

    if (!hasActiveFlash) {
      return;
    }

    const timer = setInterval(() => {
      const now = Date.now();
      setFlashTick(now);
      setFlashMarkers((prev) => {
        const next = {};
        Object.entries(prev).forEach(([id, expiresAt]) => {
          if (expiresAt > now) {
            next[id] = expiresAt;
          }
        });
        return next;
      });
    }, 500);

    return () => clearInterval(timer);
  }, [flashMarkers]);

  const filteredRows = useMemo(() => {
    const needle = searchText.trim().toLowerCase();
    return rows.filter((location) => {
      const ageInfo = ageInfoFromDate(location.last_measurement_at);
      if (stateFilter !== 'all' && ageInfo.state !== stateFilter) {
        return false;
      }

      if (!needle) {
        return true;
      }

      const haystack = [
        location.name,
        location.city,
        location.address,
        location.plz,
        location.manager,
        location.telefon,
        location.mail,
        location.project_id,
      ]
        .filter((value) => value !== null && value !== undefined)
        .join(' ')
        .toLowerCase();

      return haystack.includes(needle);
    });
  }, [rows, searchText, stateFilter]);

  const mappableRows = useMemo(
    () => filteredRows.filter(hasCoordinates),
    [filteredRows],
  );

  const stateStats = useMemo(() => {
    const counts = {
      fresh_1h: 0,
      fresh_24h: 0,
      late_72h: 0,
      stale: 0,
      no_data: 0,
    };

    rows.forEach((location) => {
      const info = ageInfoFromDate(location.last_measurement_at);
      counts[info.state] += 1;
    });
    return counts;
  }, [rows]);

  useEffect(() => {
    if (!selectedId) {
      return;
    }
    const existsInFiltered = filteredRows.some((row) => row.id === selectedId);
    if (!existsInFiltered) {
      setSelectedId(null);
    }
  }, [filteredRows, selectedId]);

  const selectedLocation = useMemo(
    () => filteredRows.find((row) => row.id === selectedId) || null,
    [selectedId, filteredRows],
  );

  return (
    <Container fluid className="py-4">
      <Row className="g-3">
        <Col xl={9} lg={8}>
          <Card style={{ minHeight: '72vh' }}>
            <Card.Header className="d-flex justify-content-between align-items-center">
              <span>Location Map</span>
              <span className="text-muted small">
                {mappableRows.length} mapped / {filteredRows.length} filtered /{' '}
                {rows.length} total
              </span>
            </Card.Header>
            <Card.Body style={{ padding: 0 }}>
              {loading ? (
                <div
                  className="d-flex justify-content-center align-items-center"
                  style={{ minHeight: '68vh' }}
                >
                  <Spinner animation="border" />
                </div>
              ) : (
                <MapContainer
                  center={DEFAULT_CENTER}
                  zoom={6}
                  style={{ height: '100vh', width: '100%' }}
                  scrollWheelZoom
                >
                  <TileLayer
                    attribution="Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community"
                    url={TILE_URL}
                  />
                  <MapViewportController
                    markers={mappableRows}
                    selectedLocation={selectedLocation}
                  />
                  {mappableRows.map((location) => {
                    const isHovered = hoveredId === location.id;
                    const isSelected = selectedId === location.id;
                    const ageInfo = ageInfoFromDate(
                      location.last_measurement_at,
                    );
                    const flashUntil = flashMarkers[location.id] || 0;
                    const flashRemaining = Math.max(0, flashUntil - flashTick);
                    const flashStrength = Math.min(
                      1,
                      flashRemaining / FLASH_DURATION_MS,
                    );
                    const flashRatio = flashStrength * 0.85;
                    const flashFill = blendHexColor(
                      ageInfo.markerFill,
                      '#ffffff',
                      flashRatio,
                    );
                    const flashStroke = blendHexColor(
                      ageInfo.markerStroke,
                      '#ffffff',
                      flashRatio,
                    );
                    const baseRadius = isSelected ? 6 : isHovered ? 5 : 4;
                    return (
                      <CircleMarker
                        key={location.id}
                        center={[location.latitude, location.longitude]}
                        radius={baseRadius + flashStrength * 2.5}
                        pathOptions={{
                          color: isSelected ? '#1d3557' : flashStroke,
                          fillColor: flashFill,
                          fillOpacity: Math.min(
                            1,
                            (isSelected ? 0.95 : 0.85) + flashStrength * 0.12,
                          ),
                          weight: (isSelected ? 2 : 1) + flashStrength,
                        }}
                        eventHandlers={{
                          mouseover: () => setHoveredId(location.id),
                          mouseout: () =>
                            setHoveredId((prev) =>
                              prev === location.id ? null : prev,
                            ),
                          click: () => setSelectedId(location.id),
                        }}
                      >
                        <Tooltip
                          direction="top"
                          offset={[0, -8]}
                          opacity={1}
                          permanent={isSelected === true}
                        >
                          <div style={{ minWidth: 180 }}>
                            <div>
                              <strong>{buildLocationLabel(location)}</strong>
                            </div>
                            {buildLocationMeta(location) && (
                              <div>{buildLocationMeta(location)}</div>
                            )}
                            {location.manager && (
                              <div>Manager: {location.manager}</div>
                            )}
                            {location.telefon && (
                              <div>Phone: {location.telefon}</div>
                            )}
                            {location.mail && <div>Mail: {location.mail}</div>}
                            <div>Devices: {location.device_count || 0}</div>
                            <div>Last measurement: {ageInfo.label}</div>
                          </div>
                        </Tooltip>
                      </CircleMarker>
                    );
                  })}
                </MapContainer>
              )}
            </Card.Body>
          </Card>
        </Col>

        <Col xl={3} lg={4}>
          <Card className="mb-3">
            <Card.Header>Statistics & Filters</Card.Header>
            <Card.Body className="m-2">
              <div className="small text-muted mb-2">Location state counts</div>
              <div className="d-flex flex-wrap gap-2 mb-3">
                <Badge bg="success">
                  {STATE_TITLES.fresh_1h}: {stateStats.fresh_1h}
                </Badge>
                <Badge bg="warning" text="dark">
                  {STATE_TITLES.fresh_24h}: {stateStats.fresh_24h}
                </Badge>
                <Badge bg="warning">
                  {STATE_TITLES.late_72h}: {stateStats.late_72h}
                </Badge>
                <Badge bg="danger">
                  {STATE_TITLES.stale}: {stateStats.stale}
                </Badge>
                <Badge bg="secondary">
                  {STATE_TITLES.no_data}: {stateStats.no_data}
                </Badge>
              </div>

              <Form.Group className="mb-3" controlId="location-map-search">
                <Form.Label className="small mb-1">Search locations</Form.Label>
                <Form.Control
                  size="sm"
                  type="text"
                  placeholder="Name, city, address, project..."
                  value={searchText}
                  onChange={(event) => setSearchText(event.target.value)}
                />
              </Form.Group>

              <Form.Group controlId="location-map-state-filter">
                <Form.Label className="small mb-1">State filter</Form.Label>
                {STATE_FILTER_OPTIONS.map((option) => (
                  <Form.Check
                    key={option.value}
                    type="radio"
                    name="location-map-state-filter"
                    label={option.label}
                    checked={stateFilter === option.value}
                    onChange={() => setStateFilter(option.value)}
                  />
                ))}
              </Form.Group>
            </Card.Body>
          </Card>

          <Card style={{ minHeight: '56vh' }}>
            <Card.Header>
              Existing Locations ({filteredRows.length})
            </Card.Header>
            <ListGroup
              variant="flush"
              style={{ maxHeight: '56vh', overflowY: 'auto' }}
            >
              {filteredRows.map((location) => {
                const isFocused =
                  hoveredId === location.id || selectedId === location.id;
                const ageInfo = ageInfoFromDate(location.last_measurement_at);
                return (
                  <ListGroup.Item
                    key={location.id}
                    action
                    active={isFocused}
                    onMouseEnter={() => setHoveredId(location.id)}
                    onMouseLeave={() =>
                      setHoveredId((prev) =>
                        prev === location.id ? null : prev,
                      )
                    }
                    onClick={() => setSelectedId(location.id)}
                    style={{ cursor: 'pointer' }}
                  >
                    <div className="d-flex justify-content-between align-items-start gap-2">
                      <div>
                        <div className="fw-semibold">
                          {buildLocationLabel(location)}
                        </div>
                        <div className="small opacity-75">
                          {buildLocationMeta(location) || 'No address data'}
                        </div>
                        <div className="small opacity-75">
                          {hasCoordinates(location)
                            ? `${location.latitude?.toFixed(5)}, ${location.longitude?.toFixed(5)}`
                            : 'No coordinates'}
                        </div>
                        <div className="small opacity-75">
                          Last measurement: {ageInfo.label}
                        </div>
                      </div>
                      <Badge
                        bg={
                          hasCoordinates(location) ? ageInfo.badge : 'secondary'
                        }
                      >
                        {hasCoordinates(location)
                          ? ageInfo.label
                          : location.device_count || 0}
                      </Badge>
                    </div>
                  </ListGroup.Item>
                );
              })}
              {!filteredRows.length && !loading && (
                <ListGroup.Item className="text-muted">
                  No locations found for this filter.
                </ListGroup.Item>
              )}
            </ListGroup>
          </Card>
        </Col>
      </Row>
    </Container>
  );
};

export default LocationsMapView;
