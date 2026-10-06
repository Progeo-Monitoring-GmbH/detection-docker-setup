// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import CookieBanner from './CookieBanner';
import { ConsentProvider, useConsent } from './ConsentProvider';
import MapConsentNotice from './MapConsentNotice';
import { readConsent, writeConsent } from './consent';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const SettingsTrigger = () => {
  const { openSettings } = useConsent();
  return (
    <button type="button" data-testid="open-settings" onClick={openSettings}>
      open
    </button>
  );
};

const renderBanner = () => {
  act(() =>
    root.render(
      <MemoryRouter>
        <ConsentProvider>
          <SettingsTrigger />
          <MapConsentNotice />
          <CookieBanner />
        </ConsentProvider>
      </MemoryRouter>,
    ),
  );
};

const dialog = () => container.querySelector('[role="dialog"]');
const mapNotice = () => container.querySelector('[role="note"]');

// Without an initialised i18next instance, t() returns the key itself.
const clickButton = (label: string) => {
  const button = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent === label,
  );
  if (!button) {
    throw new Error(`button "${label}" not found`);
  }
  act(() => button.click());
};

beforeEach(() => {
  localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('CookieBanner', () => {
  it('asks first-time visitors and blocks external maps until they decide', () => {
    renderBanner();

    expect(dialog()).not.toBeNull();
    expect(document.activeElement).toBe(dialog());
    expect(mapNotice()).not.toBeNull();
    // No close button: dismissing must not count as a decision.
    expect(container.querySelector('[aria-label="consent_close"]')).toBeNull();
  });

  it('stores a rejection and keeps maps blocked', () => {
    renderBanner();
    clickButton('consent_reject');

    expect(dialog()).toBeNull();
    expect(readConsent()?.categories.externalMaps).toBe(false);
    expect(mapNotice()).not.toBeNull();
  });

  it('stores acceptance and unblocks maps', () => {
    renderBanner();
    clickButton('consent_accept_all');

    expect(dialog()).toBeNull();
    expect(readConsent()?.categories.externalMaps).toBe(true);
    expect(mapNotice()).toBeNull();
  });

  it('saves a granular selection from the details view', () => {
    renderBanner();
    clickButton('consent_customize');

    const mapsSwitch = container.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    expect(mapsSwitch?.checked).toBe(false);
    act(() => mapsSwitch?.click());
    clickButton('consent_save');

    expect(readConsent()?.categories.externalMaps).toBe(true);
  });

  it('lets a returning user reopen the settings and revoke consent', () => {
    writeConsent({ externalMaps: true });
    renderBanner();
    expect(dialog()).toBeNull();

    act(() =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="open-settings"]')
        ?.click(),
    );
    const mapsSwitch = container.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    expect(mapsSwitch?.checked).toBe(true);

    clickButton('consent_reject');
    expect(readConsent()?.categories.externalMaps).toBe(false);
    expect(mapNotice()).not.toBeNull();
  });

  it('closes reopened settings on Escape without changing the decision', () => {
    writeConsent({ externalMaps: true });
    renderBanner();
    act(() =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="open-settings"]')
        ?.click(),
    );

    act(() => {
      dialog()?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });

    expect(dialog()).toBeNull();
    expect(readConsent()?.categories.externalMaps).toBe(true);
  });

  it('grants map consent directly from the map notice', () => {
    renderBanner();
    clickButton('consent_maps_enable');

    expect(readConsent()?.categories.externalMaps).toBe(true);
    expect(dialog()).toBeNull();
  });
});
