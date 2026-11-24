// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

const { default: PhoneInput } = await import('./PhoneInput');
const { dialForLanguage } = await import('./phone');

let container: HTMLDivElement;
let root: Root;
const changes: string[] = [];

/** React tracks the value property: set it through the prototype setter, then fire the event. */
const type = (element: HTMLInputElement | HTMLSelectElement, value: string) => {
  const proto = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value);
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
};

const Harness = ({ initial, defaultDial }: { initial: string; defaultDial?: string }) => {
  const [value, setValue] = useState(initial);
  return (
    <PhoneInput
      label="Mobil"
      value={value}
      onChange={(next) => {
        changes.push(next);
        setValue(next);
      }}
      defaultDial={defaultDial}
      testId="phone"
    />
  );
};

const number = () => container.querySelector<HTMLInputElement>('[data-testid="phone"]')!;
const country = () => container.querySelector<HTMLSelectElement>('[data-testid="phone-country"]')!;

beforeEach(() => {
  changes.length = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('PhoneInput', () => {
  it('shows a stored E.164 number split into code and number', () => {
    act(() => root.render(<Harness initial="+436641234567" />));
    expect(country().value).toBe('43');
    expect(number().value).toBe('6641234567');
  });

  it('emits E.164 while typing and keeps what was typed', () => {
    act(() => root.render(<Harness initial="" />));
    expect(country().value).toBe('49');
    act(() => type(number(), '0171 1234567'));
    expect(changes[changes.length - 1]).toBe('+491711234567');
    expect(number().value).toBe('0171 1234567');
  });

  it('starts with the location language\'s calling code - US +1 for English - a stored number keeps its own', () => {
    act(() => root.render(<Harness initial="" defaultDial={dialForLanguage('en')} />));
    expect(country().value).toBe('1');
    act(() => type(number(), '212 555 0123'));
    expect(changes[changes.length - 1]).toBe('+12125550123');

    act(() => root.render(<Harness key="stored" initial="+491711234567" defaultDial={dialForLanguage('en')} />));
    expect(country().value).toBe('49');
  });

  it('re-emits with a new calling code', () => {
    act(() => root.render(<Harness initial="+491711234567" />));
    act(() => type(country(), '41'));
    expect(changes[changes.length - 1]).toBe('+411711234567');
  });

  it('flags implausible numbers', () => {
    act(() => root.render(<Harness initial="" />));
    act(() => type(number(), '12'));
    expect(container.querySelector('[data-testid="phone-invalid"]')).not.toBeNull();
    act(() => type(number(), '1711234567'));
    expect(container.querySelector('[data-testid="phone-invalid"]')).toBeNull();
  });

  it('shows read-only numbers formatted, without the dropdown', () => {
    act(() => root.render(<PhoneInput label="Telefon" value="+4917112345678" readOnly testId="phone" />));
    expect(number().value).toBe('+49 17112345678');
    expect(container.querySelector('select')).toBeNull();
  });
});
