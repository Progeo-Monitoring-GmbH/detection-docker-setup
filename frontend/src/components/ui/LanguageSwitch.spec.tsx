// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const lang = vi.hoisted(() => ({ current: 'de', changeLanguage: vi.fn() }));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTranslation: () => ({ i18n: { language: lang.current, changeLanguage: lang.changeLanguage } }),
}));

const { default: LanguageSwitch, currentLanguage, takeChosenLanguage, CHOSEN_LANGUAGE_KEY } = await import('./LanguageSwitch');

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  sessionStorage.clear();
  lang.current = 'de';
  lang.changeLanguage.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('LanguageSwitch', () => {
  it('switches the language and remembers the explicit choice once', () => {
    act(() => root.render(<LanguageSwitch />));
    expect(container.querySelector('[aria-pressed="true"]')?.textContent).toBe('DE');

    act(() => container.querySelector<HTMLButtonElement>('[data-test-key="en"]')!.click());

    expect(lang.changeLanguage).toHaveBeenCalledWith('en');
    expect(sessionStorage.getItem(CHOSEN_LANGUAGE_KEY)).toBe('en');
    expect(takeChosenLanguage()).toBe('en');
    expect(takeChosenLanguage()).toBeNull();
  });

  it('maps browser languages to de or en', () => {
    expect(currentLanguage('en-GB')).toBe('en');
    expect(currentLanguage('de-AT')).toBe('de');
    expect(currentLanguage('fr')).toBe('de');
    expect(currentLanguage(undefined)).toBe('de');
  });
});
