// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CookieBanner from '../components/privacy/CookieBanner';
import { ConsentProvider } from '../components/privacy/ConsentProvider';
import { writeConsent } from '../components/privacy/consent';

// The page follows the portal language (German or English).
const lang = vi.hoisted(() => ({ current: 'de' }));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: {
      language: lang.current,
      changeLanguage: (code: string) => {
        lang.current = code;
        return Promise.resolve();
      },
    },
  }),
}));

const { default: PrivacyPolicyPage } = await import('./PrivacyPolicyPage');

const STORAGE_KEYS = [
  'csrftoken',
  'sessionid',
  'authToken',
  'refreshToken',
  'progeo_consent',
  'i18nextLng',
  'progeo.languageChosen',
  'progeo.sidebar.collapsed',
  'progeo.canvasKeyLegend.collapsed',
  'progeo:matrix-promo-dismissed',
  'demoToken',
  'impersonatorTokens',
  'viewAsUser',
];

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  lang.current = 'de';
  localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const renderPage = () => {
  act(() =>
    root.render(
      <MemoryRouter initialEntries={['/datenschutz']}>
        <ConsentProvider>
          <PrivacyPolicyPage />
          <CookieBanner />
        </ConsentProvider>
      </MemoryRouter>,
    ),
  );
};

describe('PrivacyPolicyPage', () => {
  it('links every table-of-contents entry to a section', () => {
    writeConsent({ externalMaps: false, statistics: false });
    renderPage();

    const tocLinks = Array.from(
      container.querySelectorAll<HTMLAnchorElement>('.privacy-toc a'),
    );
    expect(tocLinks.length).toBeGreaterThan(5);
    tocLinks.forEach((link) => {
      const id = link.getAttribute('href')?.slice(1) ?? '';
      expect(container.querySelector(`section#${id}`)).not.toBeNull();
    });
  });

  it.each(['de', 'en'])('lists every storage key the app actually uses (%s)', (language) => {
    lang.current = language;
    writeConsent({ externalMaps: false, statistics: false });
    renderPage();

    const text = container.textContent ?? '';
    STORAGE_KEYS.forEach((key) => expect(text).toContain(key));
  });

  it('comes in English with the same sections and a note that German is binding', () => {
    writeConsent({ externalMaps: false, statistics: false });
    renderPage();
    const sectionIds = (root: HTMLElement) => Array.from(root.querySelectorAll('section')).map((section) => section.id);
    const german = sectionIds(container);
    expect(container.querySelector('[data-testid="privacy-policy-language-note"]')).toBeNull();

    act(() => root.unmount());
    root = createRoot(container);
    lang.current = 'en';
    renderPage();

    expect(sectionIds(container)).toEqual(german);
    expect(container.querySelector('h1')?.textContent).toBe('Privacy policy');
    expect(container.querySelector('.privacy-page')?.getAttribute('lang')).toBe('en');
    expect(container.querySelector('[data-testid="privacy-policy-language-note"]')?.textContent).toContain(
      'Only the German version is legally binding',
    );
  });

  it('opens the privacy settings from the page', () => {
    writeConsent({ externalMaps: false, statistics: false });
    renderPage();
    expect(container.querySelector('[role="dialog"]')).toBeNull();

    const button = Array.from(container.querySelectorAll('button')).find(
      (candidate) => candidate.textContent === 'Datenschutz-Einstellungen',
    );
    act(() => button?.click());

    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  });
});
