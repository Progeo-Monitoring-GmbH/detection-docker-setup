// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const hooks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
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
  default: {
    perform_get: (_auth, url, onSuccess) => hooks.get(url, onSuccess),
    perform_post: (_auth, url, body, onSuccess, onError) => hooks.post(url, body, onSuccess, onError),
  },
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
  { id: 1, project_id: 4711, name: 'Halle', latitude: 50.1, longitude: 7.1 },
  { id: 2, project_id: 4712, name: 'Lager', latitude: 51.2, longitude: 8.2 },
];
// The plan: the locations, one chunk to scan; the chunk: location 1's devices (2 has none).
const PLAN = { locations: LOCATIONS, chunks: 1, databases: 3, activity: {} };
const CHUNK = { chunk: 0, databases: 3, activity: { 1: [2, new Date().toISOString()] } };

let container;
let root;
const byTestId = (id) => container.querySelector(`[data-testid="${id}"]`);

const render = async (plan = PLAN, chunk = CHUNK) => {
  hooks.get.mockImplementation((url, onSuccess) => onSuccess({ data: url.includes('chunk=') ? chunk : plan }));
  await act(async () => {
    root.render(<LocationsMapView />);
  });
};

// One batch of the backend (v1/legacy/live_events.py) with these locations.
const liveEvent = async (...locationIds) => {
  await act(async () => {
    hooks.sockets.at(-1).send({
      type: 'legacy_location_events',
      events: locationIds.map((id) => ({ location_id: id, project_id: 4700 + id })),
    });
  });
};

beforeEach(() => {
  hooks.map = fakeMap();
  hooks.sockets.length = 0;
  hooks.get.mockReset();
  hooks.post.mockReset();
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
  it('loads the locations first, then their activity chunk by chunk', async () => {
    await render();

    expect(hooks.get.mock.calls.map(([url]) => url)).toEqual(['/v1/location/map/', '/v1/location/map/?chunk=0']);
    // The chunk filled in location 1 (fresh), location 2 stays without data.
    const badge = (state) =>
      container.querySelector(`[data-testid="locations-map-state-count"][data-test-key="${state}"]`);
    expect(badge('fresh_1h').textContent).toContain(': 1');
    expect(badge('no_data').textContent).toContain(': 1');
    expect(byTestId('locations-map-progress')).toBeNull(); // done
  });

  it('takes the activity from the plan when every chunk is cached', async () => {
    await render({ ...PLAN, chunks: 0, activity: CHUNK.activity });

    expect(hooks.get.mock.calls.map(([url]) => url)).toEqual(['/v1/location/map/']);
    expect(
      container.querySelector('[data-testid="locations-map-state-count"][data-test-key="fresh_1h"]').textContent,
    ).toContain(': 1');
  });

  it('keeps a live update newer than the chunk', async () => {
    const old = { ...CHUNK, activity: { 2: [1, '2020-01-01T00:00:00Z'] } };
    let sendChunk;
    hooks.get.mockImplementation((url, onSuccess) => {
      if (url.includes('chunk=')) {
        sendChunk = () => onSuccess({ data: old });
      } else {
        onSuccess({ data: PLAN });
      }
    });
    await act(async () => {
      root.render(<LocationsMapView />);
    });
    expect(byTestId('locations-map-progress')).not.toBeNull();

    await liveEvent(2); // arrives before its chunk
    await act(async () => {
      sendChunk();
    });
    expect(
      container.querySelector('[data-testid="locations-map-state-count"][data-test-key="fresh_1h"]').textContent,
    ).toContain(': 1');
  });

  it('creates tooltips only for the hovered marker', async () => {
    await render();

    expect(container.querySelectorAll('[data-testid="leaflet-marker"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-testid="leaflet-tooltip"]')).toHaveLength(0);

    await act(async () => {
      container.querySelector('[data-testid="leaflet-marker"]').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(container.querySelectorAll('[data-testid="leaflet-tooltip"]')).toHaveLength(1);
    expect(byTestId('leaflet-tooltip').textContent).toContain('Devices: 2');
  });

  it('keeps the live messages muted by default until switched on, and remembers the choice', async () => {
    await render();

    expect(byTestId('locations-map-mute-toasts').textContent).toContain('locmap_toasts_off');
    await liveEvent(1);
    await liveEvent(99); // unknown location - muted as well
    expect(hooks.enqueue).not.toHaveBeenCalled();

    await act(async () => {
      byTestId('locations-map-mute-toasts').click();
    });
    expect(byTestId('locations-map-mute-toasts').textContent).toContain('locmap_toasts_on');
    await liveEvent(1);
    expect(hooks.enqueue).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem('locmap.toasts-muted')).toBe('0');
  });

  it('shows the messages right away when this browser switched them on before', async () => {
    window.localStorage.setItem('locmap.toasts-muted', '0');
    await render();

    await liveEvent(1);
    expect(hooks.enqueue).toHaveBeenCalledTimes(1);
  });

  it('shows one message per batch, not one per location', async () => {
    window.localStorage.setItem('locmap.toasts-muted', '0');
    await render();

    await liveEvent(1, 2, 99);

    const messages = hooks.enqueue.mock.calls.map(([message]) => String(message));
    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain('2 locations received new legacy measurements');
    expect(messages[1]).toContain('project 4799');
  });

  it('filters by clicking a state badge, a second click shows all again', async () => {
    await render();
    const badge = (state) =>
      container.querySelector(`[data-testid="locations-map-state-count"][data-test-key="${state}"]`);
    const markers = () => container.querySelectorAll('[data-testid="leaflet-marker"]').length;

    expect(badge('all').textContent).toBe('All: 2');
    expect(container.querySelector('[data-testid="locations-map-state-filter"]')).toBeNull();

    await act(async () => {
      badge('no_data').click();
    });
    expect(markers()).toBe(1);
    expect(badge('no_data').getAttribute('aria-pressed')).toBe('true');
    expect(badge('fresh_1h').className).toContain('locmap-state-badge--dimmed');

    await act(async () => {
      badge('no_data').click();
    });
    expect(markers()).toBe(2);
    expect(badge('all').getAttribute('aria-pressed')).toBe('true');
  });

  it('moves the map by dragging, and zooms to a dragged frame only while Z is held', async () => {
    await render();
    const mapElement = hooks.map.getContainer();
    const press = () => {
      const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
      mapElement.dispatchEvent(event);
      return event;
    };

    // Plain drag: Leaflet moves the map - nothing taken over.
    expect(hooks.map.dragging.disable).not.toHaveBeenCalled();
    expect(press().defaultPrevented).toBe(false);
    document.dispatchEvent(new MouseEvent('mouseup'));

    // Z held: dragging off, crosshair, the press starts a frame.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z' }));
    expect(hooks.map.dragging.disable).toHaveBeenCalledTimes(1);
    expect(mapElement.classList.contains('locmap-area-zoom')).toBe(true);
    expect(press().defaultPrevented).toBe(true);
    document.dispatchEvent(new MouseEvent('mouseup'));

    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'z' }));
    expect(hooks.map.dragging.enable).toHaveBeenCalled();
    expect(mapElement.classList.contains('locmap-area-zoom')).toBe(false);
  });

  it('ignores a Z typed into the search field', async () => {
    await render();

    byTestId('locations-map-search').dispatchEvent(new KeyboardEvent('keydown', { key: 'z', bubbles: true }));
    expect(hooks.map.dragging.disable).not.toHaveBeenCalled();
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

  describe('purgeable', () => {
    const OLD = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
    // 1: fresh, 2: no data yet, 3: stale, 4: stale and already marked.
    const PURGE_PLAN = {
      locations: [
        ...LOCATIONS,
        { id: 3, project_id: 4713, name: 'Alt', latitude: 52.3, longitude: 9.3 },
        { id: 4, project_id: 4714, name: 'Weg', latitude: 53.4, longitude: 10.4, purgeable: true },
      ],
      chunks: 0,
      databases: 1,
      activity: { 1: [2, new Date().toISOString()], 3: [1, OLD], 4: [1, OLD] },
    };
    const toggle = (id) =>
      container.querySelector(`[data-testid="locations-map-purge-toggle"][data-test-key="${id}"]`);
    const item = (id) => container.querySelector(`[data-testid="locations-map-item"][data-test-key="${id}"]`);
    const badge = (state) =>
      container.querySelector(`[data-testid="locations-map-state-count"][data-test-key="${state}"]`);

    it('offers the mark only for stale and never-measured locations', async () => {
      await render(PURGE_PLAN);

      expect(toggle(1)).toBeNull();
      expect(toggle(2).textContent).toBe('locmap_purgeable_mark');
      expect(toggle(3).textContent).toBe('locmap_purgeable_mark');
      expect(toggle(4).textContent).toBe('locmap_purgeable_unmark');
      expect(item(4).className).toContain('locmap-list-item--purgeable');
      expect(item(3).className).not.toContain('locmap-list-item--purgeable');
      expect(badge('purgeable').textContent).toContain(': 1');
    });

    it('marks a location without selecting it, and the purgeable badge filters', async () => {
      hooks.post.mockImplementation((url, body, onSuccess) =>
        onSuccess({ data: { location: { id: 3, purgeable: body.purgeable } } }),
      );
      await render(PURGE_PLAN);

      await act(async () => {
        toggle(3).click();
      });

      expect(hooks.post).toHaveBeenCalledWith('/v1/location/3/purgeable/', { purgeable: true }, expect.any(Function), expect.any(Function));
      expect(item(3).className).toContain('locmap-list-item--purgeable');
      expect(item(3).className).not.toContain('active');
      expect(badge('purgeable').textContent).toContain(': 2');

      await act(async () => {
        badge('purgeable').click();
      });
      const listed = [...container.querySelectorAll('[data-testid="locations-map-item"]')].map((el) =>
        el.getAttribute('data-test-key'),
      );
      expect(listed).toEqual(['3', '4']);
    });

    it('unmarks as kept (false) and keeps the flag when saving fails', async () => {
      hooks.post.mockImplementationOnce((url, body, onSuccess) =>
        onSuccess({ data: { location: { id: 4, purgeable: false } } }),
      );
      await render(PURGE_PLAN);

      await act(async () => {
        toggle(4).click();
      });
      expect(hooks.post.mock.calls[0][1]).toEqual({ purgeable: false });
      expect(item(4).className).not.toContain('locmap-list-item--purgeable');

      hooks.post.mockImplementationOnce((url, body, onSuccess, onError) => onError(new Error('nope')));
      await act(async () => {
        toggle(2).click();
      });
      expect(item(2).className).not.toContain('locmap-list-item--purgeable');
      expect(toggle(2).disabled).toBe(false);
    });
  });
});
