// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../main/FavoriteStar', () => ({
  default: ({ locationId }: { locationId: number }) => <button type="button" data-star={locationId} />,
}));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

const { locationAddressLine, isRecentMeasurement, LocationNameCell, TwoLineCell } = await import(
  './LocationListCells'
);

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('locationAddressLine', () => {
  it('joins street, postcode and city - only the parts that exist', () => {
    expect(locationAddressLine({ address: 'Hauptstr. 1', plz: '12345', city: 'Berlin' })).toBe(
      'Hauptstr. 1, 12345 Berlin',
    );
    expect(locationAddressLine({ address: ' ', plz: null, city: 'Berlin' })).toBe('Berlin');
    expect(locationAddressLine({ address: 'Hauptstr. 1' })).toBe('Hauptstr. 1');
    expect(locationAddressLine({})).toBe('');
  });
});

describe('isRecentMeasurement', () => {
  const now = Date.parse('2026-11-17T12:00:00Z');

  it('is recent within 24 hours, not older, not without a date', () => {
    expect(isRecentMeasurement('2026-11-17T01:00:00Z', now)).toBe(true);
    expect(isRecentMeasurement('2026-11-16T12:00:00Z', now)).toBe(true);
    expect(isRecentMeasurement('2026-11-16T11:59:00Z', now)).toBe(false);
    expect(isRecentMeasurement(null, now)).toBe(false);
    expect(isRecentMeasurement('not a date', now)).toBe(false);
  });
});

describe('LocationNameCell', () => {
  it('shows star, name and the address as second line', () => {
    act(() =>
      root.render(
        <LocationNameCell
          locationId={7}
          name="Halle 3"
          subline="Hauptstr. 1, 12345 Berlin"
          flags={{ notifications_disabled: false, purgeable: true, readiness_score: null }}
          testKey="x"
        />,
      ),
    );

    expect(container.querySelector('[data-star="7"]')).not.toBeNull();
    // (textContent also holds the flag icon's SVG <title>.)
    expect(container.querySelector('.location-list-primary')?.textContent).toMatch(/Halle 3$/);
    expect(container.querySelector('.location-list-secondary')?.textContent).toBe('Hauptstr. 1, 12345 Berlin');
    // The purge mark icon of LocationFlagIcons.
    expect(container.querySelector('[aria-label="location_flag_purgeable"]')).not.toBeNull();
  });

  it('leaves out an empty second line', () => {
    act(() => root.render(<TwoLineCell plain primary="Kunde A" />));

    expect(container.querySelector('.location-list-secondary')).toBeNull();
    expect(container.querySelector('.location-list-lines--plain')).not.toBeNull();
  });
});
