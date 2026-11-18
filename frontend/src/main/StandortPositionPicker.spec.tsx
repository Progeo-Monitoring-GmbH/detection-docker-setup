// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocationDetail } from './locationTypes';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// Leaflet doesn't run in jsdom: the map is a box, "dragging" it calls the
// move handler with a new center (the test's `dragTo`).
const map = vi.hoisted(() => ({
  center: { lat: 0, lng: 0 },
  move: null as null | (() => void),
}));
vi.mock('react-leaflet', () => ({
  MapContainer: ({
    children,
    center,
  }: {
    children: ReactNode;
    center: [number, number];
  }) => {
    map.center = { lat: center[0], lng: center[1] };
    return <div data-testid="leaflet">{children}</div>;
  },
  CircleMarker: () => null,
  useMapEvents: (handlers: { move: () => void }) => {
    map.move = handlers.move;
    return { getCenter: () => map.center };
  },
}));
vi.mock('./LocationsMapControls', () => ({ CtrlWheelZoom: () => null }));
vi.mock('../components/ui/MapBaseLayer', () => ({
  MapBaseTiles: () => null,
  MapLayerSwitch: () => null,
}));
vi.mock('../components/privacy/ConsentProvider', () => ({
  useConsent: () => ({ allows: () => false }),
}));
vi.mock('../components/privacy/MapConsentNotice', () => ({
  default: () => null,
}));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  }),
}));

const { default: LocationStandortPanel } =
  await import('./LocationStandortPanel');
const { distanceMeters, formatDistance, NO_POSITION_START } =
  await import('./StandortPositionPicker');

const at = (latitude: number | null, longitude: number | null) =>
  ({
    id: 1,
    latitude,
    longitude,
    device_count: 2,
    last_measurement_at: null,
  }) as unknown as LocationDetail;

let container: HTMLDivElement;
let root: Root;
const onSave = vi.fn();

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  onSave.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const byTestId = (id: string) =>
  container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const render = (location: LocationDetail, staff = true, saving = false) =>
  act(() =>
    root.render(
      <LocationStandortPanel
        location={location}
        staffPosition={
          staff ? { onRegeocode: () => undefined, onSave, saving } : undefined
        }
      />,
    ),
  );
const dragTo = (lat: number, lng: number) =>
  act(() => {
    map.center = { lat, lng };
    map.move?.();
  });

describe('correcting the position on the map (staff)', () => {
  it('opens the map to drag, follows the pin and saves its position', () => {
    render(at(50.94, 6.96));
    expect(byTestId('standort-picker')).toBeNull();

    act(() => byTestId('standort-pick')?.click());
    expect(byTestId('standort-picker')).not.toBeNull();
    expect(byTestId('standort-picker-pin')).not.toBeNull();
    // Not moved yet: nothing to save.
    expect(
      (byTestId('standort-picker-save') as HTMLButtonElement).disabled,
    ).toBe(true);

    dragTo(50.9401234567, 6.9603);
    expect(byTestId('standort-picker-coords')?.textContent).toContain(
      '50.940123, 6.960300',
    );
    expect(byTestId('standort-picker-coords')?.textContent).toContain(
      'objekt_position_pick_moved',
    );

    act(() => byTestId('standort-picker-save')?.click());
    expect(onSave).toHaveBeenCalledWith(50.940123, 6.9603);
  });

  it('closes once the new position is saved - and stays open while it is not', () => {
    render(at(50.94, 6.96));
    act(() => byTestId('standort-pick')?.click());
    render(at(50.94, 6.96), true, true);
    expect(byTestId('standort-picker')).not.toBeNull();

    render(at(50.940123, 6.9603));

    expect(byTestId('standort-picker')).toBeNull();
    expect(byTestId('standort-pick')).not.toBeNull();
  });

  it('closes without saving on cancel', () => {
    render(at(50.94, 6.96));
    act(() => byTestId('standort-pick')?.click());

    act(() => byTestId('standort-picker-cancel')?.click());

    expect(byTestId('standort-picker')).toBeNull();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('sets a first position on the map, starting with all of Germany', () => {
    render(at(null, null));

    act(() => byTestId('standort-pick-new')?.click());

    expect(map.center).toEqual({
      lat: NO_POSITION_START.lat,
      lng: NO_POSITION_START.lng,
    });
    // No position yet: saving the starting point is a choice too.
    expect(
      (byTestId('standort-picker-save') as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('is staff only', () => {
    render(at(50.94, 6.96), false);

    expect(byTestId('standort-pick')).toBeNull();
  });
});

describe('distances', () => {
  it('measures and formats how far the pin moved', () => {
    // 0.001° latitude ~ 111 m.
    expect(
      distanceMeters({ lat: 50, lng: 7 }, { lat: 50.001, lng: 7 }),
    ).toBeCloseTo(111.2, 0);
    expect(formatDistance(12.4)).toBe('12 m');
    expect(formatDistance(1450)).toMatch(/^1[.,]5 km$/);
  });
});
