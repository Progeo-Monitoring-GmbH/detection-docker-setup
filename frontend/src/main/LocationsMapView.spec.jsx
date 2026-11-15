// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const hooks = vi.hoisted(() => ({
  get: vi.fn(),
  enqueue: vi.fn(),
  sockets: [],
  map: null,
}));

// Leaflet does not run in jsdom: the map renders its markers as plain elements.
vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }) => <div data-testid="leaflet-map">{children}</div>,
  TileLayer: () => null,
  CircleMarker: ({ children, eventHandlers }) => (
    <button type="button" data-testid="leaflet-marker" onMouseOver={eventHandlers.mouseover} onClick={eventHandlers.click}>
      {children}
    </button>
  ),
  Tooltip: ({ children }) => <div data-testid="leaflet-tooltip">{children}</div>,
  useMap: () => hooks.map,
}));
vi.mock('../axiosConfig', () => ({
  default: { perform_get: (_auth, url, onSuccess) => hooks.get(url, onSuccess) },
}));
vi.mock('../../hooks/CoreAuthProvider', () => ({ useAuth: () => ({}) }));
vi.mock('notistack', () => ({ useSnackbar: () => ({ enqueueSnackbar: hooks.enqueue }) }));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (key) => key }),
}));
vi.mock('../components/privacy/ConsentProvider', () => ({ useConsent: () => ({ allows: () => false }) }));
vi.mock('../components/privacy/MapConsentNotice', () => ({ default: () => null }));
vi.mock('../backendUrl', () => ({ getWsBaseUrl: () => 'ws://test' }));

const { default: LocationsMapView } = await import('./LocationsMapView');

class FakeSocket {
  constructor(url) {
    this.url = url;
    hooks.sockets.push(this);
  }

  close() {}

  send(message) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

const fakeMap = () => {
  const container = document.createElement('div');
  return {
    getContainer: () => container,
    on: vi.fn(),
    off: vi.fn(),
    fitBounds: vi.fn(),
    setView: vi.fn(),
    flyTo: vi.fn(),
    getZoom: () => 6,
    setZoomAround: vi.fn(),
    mouseEventToContainerPoint: () => ({ x: 0, y: 0 }),
    dragging: { enable: vi.fn(), disable: vi.fn() },
    boxZoom: { enable: vi.fn(), disable: vi.fn() },
  };
};

const LOCATIONS = [
  { id: 1, project_id: 4711, name: 'Halle', latitude: 50.1, longitude: 7.1, device_count: 2,
    last_measurement_at: new Date().toISOString() },
  { id: 2, project_id: 4712, name: 'Lager', latitude: 51.2, longitude: 8.2, device_count: 1,
    last_measurement_at: null },
];

let container;
let root;
const byTestId = (id) => container.querySelector(`[data-testid="${id}"]`);

const render = async () => {
  hooks.get.mockImplementation((_url, onSuccess) => onSuccess({ data: LOCATIONS }));
  await act(async () => {
    root.render(<LocationsMapView />);
  });
};

const liveEvent = async (locationId) => {
  await act(async () => {
    hooks.sockets.at(-1).send({ type: 'legacy_location_event', location_id: locationId, project_id: 4711 });
  });
};

beforeEach(() => {
  hooks.map = fakeMap();
  hooks.sockets.length = 0;
  hooks.get.mockReset();
  hooks.enqueue.mockReset();
  window.localStorage.clear();
  vi.stubGlobal('WebSocket', FakeSocket);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('LocationsMapView', () => {
  it('loads the lean map endpoint and creates tooltips only for the hovered marker', async () => {
    await render();

    expect(hooks.get).toHaveBeenCalledWith('/v1/location/map/', expect.any(Function));
    expect(container.querySelectorAll('[data-testid="leaflet-marker"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-testid="leaflet-tooltip"]')).toHaveLength(0);

    await act(async () => {
      container.querySelector('[data-testid="leaflet-marker"]').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(container.querySelectorAll('[data-testid="leaflet-tooltip"]')).toHaveLength(1);
    expect(byTestId('leaflet-tooltip').textContent).toContain('Devices: 2');
  });

  it('shows a message per live measurement until muted, and remembers the choice', async () => {
    await render();

    await liveEvent(1);
    expect(hooks.enqueue).toHaveBeenCalledTimes(1);

    await act(async () => {
      byTestId('locations-map-mute-toasts').click();
    });
    expect(byTestId('locations-map-mute-toasts').textContent).toContain('locmap_toasts_off');
    await liveEvent(1);
    await liveEvent(99); // unknown location - muted as well
    expect(hooks.enqueue).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem('locmap.toasts-muted')).toBe('1');
  });

  it('starts muted when the browser remembers it', async () => {
    window.localStorage.setItem('locmap.toasts-muted', '1');
    await render();

    await liveEvent(1);
    expect(hooks.enqueue).not.toHaveBeenCalled();
  });

  it('drags a frame to zoom by default and moves the map in the other mode', async () => {
    await render();

    // Zoom to area: the map's own dragging (and Shift-frame) is off, a crosshair shows.
    expect(hooks.map.dragging.disable).toHaveBeenCalled();
    expect(hooks.map.getContainer().classList.contains('locmap-area-zoom')).toBe(true);

    await act(async () => {
      container.querySelector('[data-testid="locations-map-mode-option"][data-test-key="pan"]').click();
    });
    expect(hooks.map.dragging.enable).toHaveBeenCalled();
    expect(hooks.map.getContainer().classList.contains('locmap-area-zoom')).toBe(false);
  });

  it('fits all markers again on "Show all"', async () => {
    await render();
    const fits = hooks.map.fitBounds.mock.calls.length;

    await act(async () => {
      byTestId('locations-map-show-all').click();
    });
    expect(hooks.map.fitBounds.mock.calls.length).toBe(fits + 1);
  });
});
