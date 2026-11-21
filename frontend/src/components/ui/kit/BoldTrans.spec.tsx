// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import BoldTrans from './BoldTrans';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeAll(async () => {
  // As in i18n.jsx: escapeValue false (React escapes).
  await i18next.use(initReactI18next).init({
    lng: 'de',
    resources: {
      de: {
        translation: {
          msg: 'Die Eskalation <strong>"{{title}}"</strong> mit <b>{{count}} Alarm(en)</b> wird geschlossen.',
        },
      },
    },
    interpolation: { escapeValue: false },
  });
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('BoldTrans', () => {
  it('renders the marked parts bold, the rest as text', () => {
    act(() => root.render(<BoldTrans i18nKey="msg" values={{ title: 'Feuchte B2', count: 3 }} />));
    const bold = [...container.querySelectorAll('strong')].map((element) => element.textContent);
    expect(bold).toEqual(['"Feuchte B2"', '3 Alarm(en)']);
    expect(container.textContent).toBe('Die Eskalation "Feuchte B2" mit 3 Alarm(en) wird geschlossen.');
  });

  it('keeps markup in a value as text', () => {
    act(() => root.render(<BoldTrans i18nKey="msg" values={{ title: '<i>A & B</i>', count: 1 }} />));
    expect(container.querySelector('i')).toBeNull();
    expect(container.querySelector('strong')?.textContent).toBe('"<i>A & B</i>"');
  });
});
