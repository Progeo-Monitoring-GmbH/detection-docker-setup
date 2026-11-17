import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getWsBaseUrl } from '../backendUrl';
import {
  Badge,
  Card,
  Col,
  Container,
  Form,
  ListGroup,
  Row,
  ProgressBar,
  Spinner,
} from 'react-bootstrap';
import {
  ArrowCounterclockwise,
  ArrowsFullscreen,
  BellFill,
  BellSlashFill,
  Trash3,
  Trash3Fill,
} from 'react-bootstrap-icons';
import {
  CircleMarker,
  MapContainer,
  Tooltip,
  useMap,
} from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import { useTranslation } from 'react-i18next';

import { useSnackbar } from 'notistack';

import { useAuth } from '../../hooks/CoreAuthProvider';
import axiosConfig from '../axiosConfig';
import { matchesLocationSearch } from '../components/location/locationSearch';
import { showInfoBar, showRequestError, showSuccessBar } from '../components/ui/Snackbar.jsx';
import PillButton from '../components/ui/kit/PillButton';
import { KeyChip } from '../components/ui/KeyHints';
import { useWheelHint, WheelZoomHint } from '../components/ui/wheelZoom';
import { useConsent } from '../components/privacy/ConsentProvider';
import MapConsentNotice from '../components/privacy/MapConsentNotice';
import { MapBaseTiles, MapLayerSwitch } from '../components/ui/MapBaseLayer';
import { useMapBaseLayer } from '../components/ui/mapLayers';
import { repeatedTestId } from '../testIds';
import {
  LOCATION_OFF_CLASS,
  LocationFlagIcons,
  setLocationFlags,
  useLocationFlags,
} from '../components/location/locationFlags';
import { runChunks } from './deviceStatisticsBuild';
import { AreaZoom, CtrlWheelZoom } from './LocationsMapControls';
import './LocationsMapView.css';

const DEFAULT_CENTER = [51.1657, 10.4515];
const FLASH_DURATION_MS = 30000;
/** Flash strength in steps: a marker re-renders a few times while fading, not every tick. */
const FLASH_STEPS = 20;
// Per browser: whether the live measurement messages are muted.
const TOASTS_MUTED_KEY = 'locmap.toasts-muted';

// Tiles: components/ui/mapLayers.ts (satellite / hybrid / street, or the
// own tile server of VITE_MAP_TILE_URL for offline deployments).

/**
 * GET: the locations at once and how many chunks of project databases to
 * scan; ?chunk=k: the device count and last measurement of the k-th chunk's
 * locations - like the device statistics' chunked build.
 */
const MAP_URL = '/v1/location/map/';
/** Chunk requests at a time - each one already queries its databases in parallel on the server. */
const CHUNK_CONCURRENCY = 2;

/**
 * The rows with a chunk's activity ({id: [device count, last measurement]})
 * - a live update newer than the chunk's last measurement is kept.
 */
const withActivity = (rows, activity) => {
  if (!activity || !Object.keys(activity).length) {
    return rows;
  }
  return rows.map((row) => {
    const entry = activity[row.id];
    if (!entry) {
      return row;
    }
    const [deviceCount, last] = entry;
    const newest =
      row.last_measurement_at && (!last || Date.parse(row.last_measurement_at) > Date.parse(last))
        ? row.last_measurement_at
        : last;
    return { ...row, device_count: deviceCount, last_measurement_at: newest };
  });
};

/** Muted unless this browser switched the messages on ("0"). */
const readToastsMuted = () => {
  try {
    return window.localStorage.getItem(TOASTS_MUTED_KEY) !== '0';
  } catch {
    return true;
  }
};

const storeToastsMuted = (muted) => {
  try {
    window.localStorage.setItem(TOASTS_MUTED_KEY, muted ? '1' : '0');
  } catch {
    // Storage unavailable (private mode): the choice holds for this visit only.
  }
};

const hasCoordinates = (location) =>
  typeof location.latitude === 'number' &&
  Number.isFinite(location.latitude) &&
  typeof location.longitude === 'number' &&
  Number.isFinite(location.longitude);

/**
 * Fits the map to the markers - until the user moves or zooms by hand
 * (`interactedRef`, also set by the zoom controls), so live updates never
 * yank the view away. `fitRequest` changes: fit again ("Show all").
 */
const MapViewportController = ({ markers, selectedLocation, interactedRef, fitRequest }) => {
  const map = useMap();
  // Signature of the markers' spatial content only (id + coordinates):
  // websocket updates that merely refresh last_measurement_at keep it.
  const fittedSignatureRef = useRef(null);
  const fitRequestRef = useRef(fitRequest);

  useEffect(() => {
    const markInteracted = () => {
      interactedRef.current = true;
    };
    map.on('dragstart', markInteracted);
    return () => {
      map.off('dragstart', markInteracted);
    };
  }, [map, interactedRef]);

  useEffect(() => {
    const requested = fitRequest !== fitRequestRef.current;
    fitRequestRef.current = fitRequest;
    if (interactedRef.current && !requested) {
      return;
    }
    const signature = markers
      .map((location) => `${location.id}:${location.latitude},${location.longitude}`)
      .sort()
      .join('|');
    if (signature === fittedSignatureRef.current && !requested) {
      return;
    }
    fittedSignatureRef.current = signature;
    interactedRef.current = false;

    if (!markers.length) {
      map.setView(DEFAULT_CENTER, 6);
      return;
    }
    map.fitBounds(
      markers.map((location) => [location.latitude, location.longitude]),
      { padding: [32, 32], maxZoom: 16 },
    );
  }, [map, markers, interactedRef, fitRequest]);

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

/** The state badges - each one filters the map and the list to its state. */
const STATE_BADGES = [
  { state: 'all', bg: 'dark' },
  { state: 'fresh_1h', bg: 'success' },
  { state: 'fresh_24h', bg: 'warning', text: 'dark' },
  { state: 'late_72h', bg: 'warning' },
  { state: 'stale', bg: 'danger' },
  { state: 'no_data', bg: 'secondary' },
  // Not an age: the locations staff marked for the purge script.
  { state: 'purgeable', bg: 'light', text: 'dark' },
];

/** Staff may mark these states as purgeable (ProgeoLocation.purgeable). */
const PURGE_CANDIDATE_STATES = new Set(['stale', 'no_data']);

const isPurgeable = (location) => location.purgeable === true;

/** A purgeable location looks switched off: grey, dashed, see-through. */
const PURGEABLE_MARKER = { fill: '#dee2e6', stroke: '#6c757d' };

const matchesStateFilter = (location, stateFilter) => {
  if (stateFilter === 'all') {
    return true;
  }
  if (stateFilter === 'purgeable') {
    return isPurgeable(location);
  }
  return ageInfoFromDate(location.last_measurement_at).state === stateFilter;
};

const STATE_TITLES = {
  fresh_1h: 'Fresh (<=1h)',
  fresh_24h: 'Recent (<=24h)',
  late_72h: 'Late (<=72h)',
  stale: 'Stale (>72h)',
  no_data: 'No data yet',
  purgeable: 'Purgeable',
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
  const channel = (offset) => {
    const a = parseInt(from.slice(offset, offset + 2), 16);
    const b = parseInt(to.slice(offset, offset + 2), 16);
    return Math.round(a + (b - a) * clampT)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${channel(0)}${channel(2)}${channel(4)}`;
};

/**
 * One location on the map. Memoized: a hover, a selection or a live update
 * re-renders the markers it concerns, not all of them. The tooltip only
 * exists while the marker is hovered or selected - one per marker made the
 * map slow with many locations.
 */
const LocationMarker = memo(({ location, isHovered, isSelected, flash, onHover, onLeave, onSelect }) => {
  const { t } = useTranslation();
  const ageInfo = ageInfoFromDate(location.last_measurement_at);
  const purgeable = isPurgeable(location);
  const fill = purgeable ? PURGEABLE_MARKER.fill : ageInfo.markerFill;
  const stroke = purgeable ? PURGEABLE_MARKER.stroke : ageInfo.markerStroke;
  const flashRatio = flash * 0.85;
  const eventHandlers = useMemo(
    () => ({
      mouseover: () => onHover(location.id),
      mouseout: () => onLeave(location.id),
      click: () => onSelect(location.id),
    }),
    [location.id, onHover, onLeave, onSelect],
  );
  const baseRadius = isSelected ? 6 : isHovered ? 5 : 4;
  return (
    <CircleMarker
      center={[location.latitude, location.longitude]}
      radius={baseRadius + flash * 2.5}
      pathOptions={{
        color: isSelected ? '#1d3557' : blendHexColor(stroke, '#ffffff', flashRatio),
        fillColor: blendHexColor(fill, '#ffffff', flashRatio),
        fillOpacity: purgeable ? 0.45 : Math.min(1, (isSelected ? 0.95 : 0.85) + flash * 0.12),
        weight: (isSelected ? 2 : 1) + flash,
        dashArray: purgeable ? '2 3' : undefined,
      }}
      eventHandlers={eventHandlers}
    >
      {(isHovered || isSelected) && (
        <Tooltip direction="top" offset={[0, -8]} opacity={1} permanent>
          <div className="locmap-tooltip" {...repeatedTestId('locations-map-tooltip', location.id)}>
            <div>
              <strong>{buildLocationLabel(location)}</strong>
            </div>
            {buildLocationMeta(location) && <div>{buildLocationMeta(location)}</div>}
            {location.manager && <div>Manager: {location.manager}</div>}
            {location.telefon && <div>Phone: {location.telefon}</div>}
            {location.mail && <div>Mail: {location.mail}</div>}
            <div>Devices: {location.device_count || 0}</div>
            <div>Last measurement: {ageInfo.label}</div>
            {purgeable && (
              <div className="locmap-tooltip-purgeable" {...repeatedTestId('locations-map-tooltip-purgeable', location.id)}>
                <Trash3Fill size={11} className="me-1" />
                {t('locmap_purgeable_marked')}
              </div>
            )}
          </div>
        </Tooltip>
      )}
    </CircleMarker>
  );
});
LocationMarker.displayName = 'LocationMarker';

/**
 * One location of the list - memoized like LocationMarker. Stale and
 * never-measured locations get a button to mark them purgeable (only the
 * flag, a later script deletes them); a marked location looks switched off
 * and can be unmarked. A div, not a button: it holds that button.
 */
const LocationListItem = memo(
  ({ location, notificationsOff, readinessScore, isFocused, busy, onHover, onLeave, onSelect, onTogglePurgeable }) => {
  const { t } = useTranslation();
  const ageInfo = ageInfoFromDate(location.last_measurement_at);
  const mapped = hasCoordinates(location);
  const purgeable = isPurgeable(location);
  const candidate = purgeable || PURGE_CANDIDATE_STATES.has(ageInfo.state);
  const classes = ['locmap-list-item'];
  if (purgeable) {
    classes.push('locmap-list-item--purgeable');
  }
  // Switched off (notifications off / purgeable): the stripes of every location table.
  if (purgeable || notificationsOff) {
    classes.push(LOCATION_OFF_CLASS);
  }
  return (
    <ListGroup.Item
      as="div"
      action
      role="button"
      tabIndex={0}
      active={isFocused}
      onMouseEnter={() => onHover(location.id)}
      onMouseLeave={() => onLeave(location.id)}
      onClick={() => onSelect(location.id)}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          onSelect(location.id);
        }
      }}
      className={classes.join(' ')}
      {...repeatedTestId('locations-map-item', location.id)}
    >
      <div className="d-flex justify-content-between align-items-start gap-2">
        <div>
          <div className="fw-semibold">
            <LocationFlagIcons
              flags={{
                id: location.id,
                notifications_disabled: notificationsOff,
                purgeable,
                readiness_score: readinessScore,
              }}
              testKey={`map-${location.id}`}
            />
            {buildLocationLabel(location)}
          </div>
          <div className="small opacity-75">{buildLocationMeta(location) || 'No address data'}</div>
          <div className="small opacity-75">
            {mapped
              ? `${location.latitude.toFixed(5)}, ${location.longitude.toFixed(5)}`
              : 'No coordinates'}
          </div>
          <div className="small opacity-75">Last measurement: {ageInfo.label}</div>
        </div>
        <div className="d-flex flex-column align-items-end gap-1">
          <Badge bg={purgeable ? 'light' : mapped ? ageInfo.badge : 'secondary'} text={purgeable ? 'dark' : undefined}>
            {purgeable ? t('locmap_purgeable_badge') : mapped ? ageInfo.label : location.device_count || 0}
          </Badge>
          {candidate && (
            <button
              type="button"
              className="btn btn-sm locmap-purge-button"
              disabled={busy}
              title={purgeable ? t('locmap_purgeable_unmark_title') : t('locmap_purgeable_mark_title')}
              onClick={(event) => {
                event.stopPropagation();
                onTogglePurgeable(location);
              }}
              {...repeatedTestId('locations-map-purge-toggle', location.id)}
            >
              {purgeable ? <ArrowCounterclockwise size={12} className="me-1" /> : <Trash3 size={12} className="me-1" />}
              {purgeable ? t('locmap_purgeable_unmark') : t('locmap_purgeable_mark')}
            </button>
          )}
        </div>
      </div>
    </ListGroup.Item>
  );
  },
);
LocationListItem.displayName = 'LocationListItem';

/**
 * Staff (superuser) map of every location: coloured by the age of its last
 * measurement, live updates over the websocket (marker flash + a message,
 * which can be muted). Data: GET /v1/location/map/ - only what the map
 * shows, cached for a minute by the backend.
 */
const LocationsMapView = () => {
  const { t } = useTranslation();
  const auth = useAuth();
  // The load runs once per mount - through a ref, a new auth object doesn't restart the chunks.
  const authRef = useRef(auth);
  authRef.current = auth;
  const { allows } = useConsent();
  const [baseLayer, setBaseLayer] = useMapBaseLayer();
  const { enqueueSnackbar } = useSnackbar();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [hoveredId, setHoveredId] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [searchText, setSearchText] = useState('');
  const [stateFilter, setStateFilter] = useState('all');
  const [flashMarkers, setFlashMarkers] = useState({});
  const [flashTick, setFlashTick] = useState(Date.now());
  const [toastsMuted, setToastsMuted] = useState(readToastsMuted);
  // While the activity chunks load: {done, total} databases.
  const [activityProgress, setActivityProgress] = useState(null);
  const [fitRequest, setFitRequest] = useState(0);
  // Locations whose purgeable flag is being saved.
  const [purgeBusy, setPurgeBusy] = useState({});
  const [wheelHint, showWheelHint] = useWheelHint();
  const interactedRef = useRef(false);
  // The websocket handler is set up once - it reads these through refs.
  const rowsRef = useRef(rows);
  const toastsMutedRef = useRef(toastsMuted);
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);
  useEffect(() => {
    toastsMutedRef.current = toastsMuted;
    storeToastsMuted(toastsMuted);
  }, [toastsMuted]);

  // The locations come at once, their activity chunk by chunk (MAP_URL).
  useEffect(() => {
    let cancelled = false;
    const get = (query) =>
      new Promise((resolve, reject) => {
        void axiosConfig.perform_get(
          authRef.current,
          `${MAP_URL}${query}`,
          (response) => resolve(response?.data ?? {}),
          reject,
        );
      });
    const load = async () => {
      setLoading(true);
      try {
        const plan = await get('');
        if (cancelled) {
          return;
        }
        setRows(withActivity(plan.locations || [], plan.activity));
        setLoading(false);
        const chunks = Number(plan.chunks) || 0;
        if (!chunks) {
          return;
        }
        setActivityProgress({ done: 0, total: Number(plan.databases) || 0 });
        await runChunks(
          chunks,
          CHUNK_CONCURRENCY,
          async (index) => {
            const chunk = await get(`?chunk=${index}`);
            if (cancelled) {
              return;
            }
            setRows((current) => withActivity(current, chunk.activity));
            setActivityProgress(
              (current) => current && { ...current, done: current.done + (Number(chunk.databases) || 0) },
            );
          },
          () => cancelled,
        );
      } catch (error) {
        if (!cancelled) {
          showRequestError(enqueueSnackbar, 'Could not load locations', error);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
          setActivityProgress(null);
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [enqueueSnackbar]);

  useEffect(() => {
    const ws = new WebSocket(`${getWsBaseUrl()}/ws/commands/list`);

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message?.type !== 'legacy_location_events' || !Array.isArray(message.events)) {
          return;
        }

        // Every project that measured since the last batch (backend: every
        // 10 s, v1/legacy/live_events.py) - ids only, the details are in the
        // loaded rows.
        const known = [];
        const unknownProjects = [];
        message.events.forEach((item) => {
          const location = rowsRef.current.find((row) => row.id === item?.location_id);
          if (location) {
            known.push(location);
          } else {
            unknownProjects.push(item?.project_id);
          }
        });

        if (known.length) {
          const ids = new Set(known.map((location) => location.id));
          const nowIso = new Date().toISOString();
          const flashUntil = Date.now() + FLASH_DURATION_MS;
          setRows((prev) =>
            prev.map((row) => (ids.has(row.id) ? { ...row, last_measurement_at: nowIso } : row)),
          );
          setFlashMarkers((prev) => ({
            ...prev,
            ...Object.fromEntries([...ids].map((id) => [id, flashUntil])),
          }));
        }

        if (toastsMutedRef.current) {
          return;
        }
        // One toast per batch, not one per location.
        if (known.length === 1) {
          showInfoBar(
            enqueueSnackbar,
            `Live update: ${buildLocationLabel(known[0])} received new legacy measurement`,
          );
        } else if (known.length > 1) {
          showInfoBar(enqueueSnackbar, `Live update: ${known.length} locations received new legacy measurements`);
        }
        if (unknownProjects.length) {
          showInfoBar(
            enqueueSnackbar,
            `Legacy measurement parsed for project ${unknownProjects.join(', ')}`,
          );
        }
      } catch {
        // Ignore malformed websocket payloads.
      }
    };

    return () => {
      ws.close();
    };
  }, [enqueueSnackbar]);

  const hasActiveFlash = Object.keys(flashMarkers).length > 0;
  useEffect(() => {
    if (!hasActiveFlash) {
      return undefined;
    }
    const timer = setInterval(() => {
      const now = Date.now();
      setFlashTick(now);
      setFlashMarkers((prev) => {
        const entries = Object.entries(prev).filter(([, expiresAt]) => expiresAt > now);
        return entries.length === Object.keys(prev).length ? prev : Object.fromEntries(entries);
      });
    }, 500);
    return () => clearInterval(timer);
  }, [hasActiveFlash]);

  const filteredRows = useMemo(
    () =>
      rows.filter(
        (location) => matchesStateFilter(location, stateFilter) && matchesLocationSearch(location, searchText),
      ),
    [rows, searchText, stateFilter],
  );

  const mappableRows = useMemo(() => filteredRows.filter(hasCoordinates), [filteredRows]);
  // Notifications switched off (the purge mark is in the rows): the list's stripes.
  const { flagsOf } = useLocationFlags(rows.map((row) => row.id));

  const stateStats = useMemo(() => {
    const counts = { fresh_1h: 0, fresh_24h: 0, late_72h: 0, stale: 0, no_data: 0, purgeable: 0 };
    rows.forEach((location) => {
      counts[ageInfoFromDate(location.last_measurement_at).state] += 1;
      if (isPurgeable(location)) {
        counts.purgeable += 1;
      }
    });
    return counts;
  }, [rows]);

  useEffect(() => {
    if (selectedId && !filteredRows.some((row) => row.id === selectedId)) {
      setSelectedId(null);
    }
  }, [filteredRows, selectedId]);

  const selectedLocation = useMemo(
    () => filteredRows.find((row) => row.id === selectedId) || null,
    [selectedId, filteredRows],
  );

  // Stable handlers - the memoized markers and list items keep them.
  const hover = useCallback((id) => setHoveredId(id), []);
  const leave = useCallback((id) => setHoveredId((prev) => (prev === id ? null : prev)), []);
  const select = useCallback((id) => setSelectedId(id), []);
  const markInteracted = useCallback(() => {
    interactedRef.current = true;
  }, []);

  /** Mark / unmark a location as purgeable (unmark = reviewed, kept: false). */
  const togglePurgeable = useCallback(
    (location) => {
      const purgeable = !isPurgeable(location);
      setPurgeBusy((current) => ({ ...current, [location.id]: true }));
      void axiosConfig.perform_post(
        authRef.current,
        `/v1/location/${location.id}/purgeable/`,
        { purgeable },
        (response) => {
          const saved = response?.data?.location?.purgeable ?? purgeable;
          setRows((current) => current.map((row) => (row.id === location.id ? { ...row, purgeable: saved } : row)));
          setLocationFlags(location.id, { purgeable: saved });
          setPurgeBusy((current) => ({ ...current, [location.id]: false }));
          showSuccessBar(
            enqueueSnackbar,
            t(saved ? 'locmap_purgeable_marked_toast' : 'locmap_purgeable_unmarked_toast', {
              name: buildLocationLabel(location),
            }),
          );
        },
        (error) => {
          setPurgeBusy((current) => ({ ...current, [location.id]: false }));
          showRequestError(enqueueSnackbar, t('locmap_purgeable_error'), error);
        },
      );
    },
    [enqueueSnackbar, t],
  );

  const flashOf = (id) => {
    const remaining = (flashMarkers[id] || 0) - flashTick;
    return remaining > 0 ? Math.ceil((remaining / FLASH_DURATION_MS) * FLASH_STEPS) / FLASH_STEPS : 0;
  };

  return (
    <Container fluid className="py-4" data-testid="page-locations-map">
      <Row className="g-3">
        <Col xl={9} lg={8}>
          <Card className="locmap-map-card" data-testid="locations-map-card">
            <Card.Header className="locmap-map-header">
              <span>Location Map</span>
              <span className="text-muted small" data-testid="locations-map-counts">
                {mappableRows.length} mapped / {filteredRows.length} filtered / {rows.length} total
              </span>
              <div className="locmap-toolbar">
                <span className="locmap-key-hint" data-testid="locations-map-zoom-hint">
                  <KeyChip>Z</KeyChip> + {t('locmap_zoom_area_hint')}
                </span>
                <PillButton
                  variant="ghost"
                  icon={<ArrowsFullscreen size={13} />}
                  label={t('locmap_show_all')}
                  onClick={() => setFitRequest((value) => value + 1)}
                  testId="locations-map-show-all"
                />
                <PillButton
                  variant="ghost"
                  active={toastsMuted}
                  icon={toastsMuted ? <BellSlashFill size={13} /> : <BellFill size={13} />}
                  label={toastsMuted ? t('locmap_toasts_off') : t('locmap_toasts_on')}
                  title={t('locmap_toasts_title')}
                  onClick={() => setToastsMuted((muted) => !muted)}
                  testId="locations-map-mute-toasts"
                />
              </div>
              {activityProgress && (
                <div className="locmap-progress" data-testid="locations-map-progress">
                  <span className="small text-muted">
                    {t('locmap_loading_activity', {
                      done: activityProgress.done,
                      total: activityProgress.total,
                    })}
                  </span>
                  <ProgressBar
                    now={activityProgress.done}
                    max={Math.max(activityProgress.total, 1)}
                    animated
                    className="locmap-progress-bar"
                  />
                </div>
              )}
            </Card.Header>
            <Card.Body className="locmap-map-body" data-testid="locations-map-map">
              {loading ? (
                <div
                  className="d-flex justify-content-center align-items-center locmap-loading"
                  data-testid="locations-map-loading"
                >
                  <Spinner animation="border" />
                </div>
              ) : (
                <MapContainer
                  center={DEFAULT_CENTER}
                  zoom={6}
                  className="locmap-map"
                  // Canvas instead of one SVG element per marker - hundreds of markers stay fast.
                  preferCanvas
                  scrollWheelZoom={false}
                >
                  {allows('externalMaps') && <MapBaseTiles layer={baseLayer} />}
                  <MapViewportController
                    markers={mappableRows}
                    selectedLocation={selectedLocation}
                    interactedRef={interactedRef}
                    fitRequest={fitRequest}
                  />
                  <AreaZoom onZoomed={markInteracted} />
                  <CtrlWheelZoom onZoomed={markInteracted} onPlain={showWheelHint} />
                  {mappableRows.map((location) => (
                    <LocationMarker
                      key={location.id}
                      location={location}
                      isHovered={hoveredId === location.id}
                      isSelected={selectedId === location.id}
                      flash={flashOf(location.id)}
                      onHover={hover}
                      onLeave={leave}
                      onSelect={select}
                    />
                  ))}
                </MapContainer>
              )}
              {!loading && <WheelZoomHint visible={wheelHint} testId="locations-map-wheel-hint" />}
              {!loading && allows('externalMaps') && (
                <MapLayerSwitch value={baseLayer} onChange={setBaseLayer} />
              )}
              {!loading && <MapConsentNotice placement="top" />}
            </Card.Body>
          </Card>
        </Col>

        <Col xl={3} lg={4}>
          <Card className="mb-3" data-testid="locations-map-filters">
            <Card.Header>Statistics & Filters</Card.Header>
            <Card.Body className="m-2">
              <div className="small text-muted mb-2">Location states - click one to filter</div>
              <div className="d-flex flex-wrap gap-2 mb-3" data-testid="locations-map-state-counts">
                {STATE_BADGES.map(({ state, bg, text }) => {
                  const active = stateFilter === state;
                  const classes = ['locmap-state-badge'];
                  if (active) {
                    classes.push('locmap-state-badge--active');
                  } else if (stateFilter !== 'all') {
                    classes.push('locmap-state-badge--dimmed');
                  }
                  return (
                    <Badge
                      key={state}
                      as="button"
                      type="button"
                      bg={bg}
                      text={text}
                      className={classes.join(' ')}
                      aria-pressed={active}
                      // A second click on the active state shows all again.
                      onClick={() => setStateFilter((current) => (current === state ? 'all' : state))}
                      {...repeatedTestId('locations-map-state-count', state)}
                    >
                      {state === 'purgeable' && <Trash3Fill size={10} className="me-1" />}
                      {state === 'all' ? 'All' : STATE_TITLES[state]}:{' '}
                      {state === 'all' ? rows.length : stateStats[state]}
                    </Badge>
                  );
                })}
              </div>

              <Form.Group className="mb-3" controlId="location-map-search">
                <Form.Label className="small mb-1">Search locations</Form.Label>
                <Form.Control
                  size="sm"
                  type="text"
                  placeholder="Name, address, postcode, city, project id…"
                  value={searchText}
                  onChange={(event) => setSearchText(event.target.value)}
                  data-testid="locations-map-search"
                />
              </Form.Group>
            </Card.Body>
          </Card>

          <Card className="locmap-list-card" data-testid="locations-map-list-card">
            <Card.Header data-testid="locations-map-list-count">
              Existing Locations ({filteredRows.length})
            </Card.Header>
            <ListGroup variant="flush" className="locmap-list" data-testid="locations-map-list">
              {filteredRows.map((location) => (
                <LocationListItem
                  key={location.id}
                  location={location}
                  isFocused={hoveredId === location.id || selectedId === location.id}
                  notificationsOff={flagsOf(location.id)?.notifications_disabled === true}
                  readinessScore={flagsOf(location.id)?.readiness_score ?? null}
                  busy={Boolean(purgeBusy[location.id])}
                  onHover={hover}
                  onLeave={leave}
                  onSelect={select}
                  onTogglePurgeable={togglePurgeable}
                />
              ))}
              {!filteredRows.length && !loading && (
                <ListGroup.Item className="text-muted" data-testid="locations-map-empty">
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
