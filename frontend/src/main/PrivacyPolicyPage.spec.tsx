// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import CookieBanner from '../components/privacy/CookieBanner';
import { ConsentProvider } from '../components/privacy/ConsentProvider';
import { writeConsent } from '../components/privacy/consent';
import PrivacyPolicyPage from './PrivacyPolicyPage';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

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
    writeConsent({ externalMaps: false });
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

  it('lists every storage key the app actually uses', () => {
    writeConsent({ externalMaps: false });
    renderPage();

    const text = container.textContent ?? '';
    [
      'csrftoken',
      'sessionid',
      'authToken',
      'progeo_consent',
      'i18nextLng',
    ].forEach((key) => expect(text).toContain(key));
  });

  it('opens the privacy settings from the page', () => {
    writeConsent({ externalMaps: false });
    renderPage();
    expect(container.querySelector('[role="dialog"]')).toBeNull();

    const button = Array.from(container.querySelectorAll('button')).find(
      (candidate) => candidate.textContent === 'Datenschutz-Einstellungen',
    );
    act(() => button?.click());

    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  });
});
