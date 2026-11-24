// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountBoxes, AccountPicker, initialNewUserAccounts, type UserAccount } from './staffAccounts';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const ACCOUNTS: UserAccount[] = [
  { id: 1, name: 'Eigen' },
  { id: 2, name: 'Zweit' },
];
const many = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    name: `Account ${index + 1}`,
  }));

describe('initialNewUserAccounts (Add user)', () => {
  const choices: UserAccount[] = [
    { id: 1, name: 'Mit Objekten', has_locations: true },
    { id: 2, name: 'Leer', has_locations: false },
    { id: 3, name: 'Auch leer', has_locations: false },
  ];

  it("ticks a customer admin's accounts without a location", () => {
    expect(initialNewUserAccounts(choices, true)).toEqual([2, 3]);
  });

  it('ticks their only account in any case - a new user needs one', () => {
    expect(initialNewUserAccounts([choices[0]], true)).toEqual([1]);
  });

  it('leaves the choice to staff', () => {
    expect(initialNewUserAccounts(choices, false)).toEqual([]);
  });
});

describe('AccountPicker', () => {
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

  const render = (props: Partial<Parameters<typeof AccountPicker>[0]> = {}) => {
    const onChange = vi.fn();
    act(() =>
      root.render(
        <AccountPicker
          choices={ACCOUNTS}
          selected={[1]}
          onChange={onChange}
          colorOf={() => '#123456'}
          testId="picker"
          {...props}
        />,
      ),
    );
    return onChange;
  };
  const box = (id: number) =>
    container.querySelector<HTMLInputElement>(
      `[data-testid="picker-account"][data-test-key="${id}"]`,
    )!;

  it('ticks the accounts of the user and hands out / takes away one per click', () => {
    const onChange = render();

    expect([box(1).checked, box(2).checked]).toEqual([true, false]);
    act(() => box(2).click());
    expect(onChange).toHaveBeenLastCalledWith([1, 2]);
    act(() => box(1).click());
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it('gets a search field once there are many accounts', () => {
    render({ choices: ACCOUNTS });
    expect(container.querySelector('[data-testid="picker-search"]')).toBeNull();

    render({ choices: many(12), selected: [] });
    const search = container.querySelector<HTMLInputElement>(
      '[data-testid="picker-search"]',
    )!;
    act(() => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!;
      setValue.call(search, 'Account 1');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // "Account 1", "Account 10", "Account 11", "Account 12".
    expect(
      container.querySelectorAll('[data-testid="picker-account"]'),
    ).toHaveLength(4);
  });

  it('only names the accounts, with why, when they cannot be changed', () => {
    render({
      locked: 'Only ProGeo staff can change the accounts of a customer admin.',
    });

    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(
      0,
    );
    expect(container.textContent).toContain('Eigen');
    expect(container.textContent).not.toContain('Zweit');
    expect(
      container.querySelector('[data-testid="picker-locked"]')!.textContent,
    ).toBe('Only ProGeo staff can change the accounts of a customer admin.');
  });
});

describe('AccountBoxes (the Accounts column)', () => {
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

  const render = (accounts: UserAccount[], singleAccess: number) =>
    act(() =>
      root.render(
        <AccountBoxes
          userId={7}
          accounts={accounts}
          singleAccess={singleAccess}
          colorOf={() => '#123456'}
        />,
      ),
    );
  const count = () =>
    container.querySelector('[data-testid="staff-user-single-access"]');

  it('shows a box per account and the single access beyond them', () => {
    render(ACCOUNTS, 3);
    expect(container.querySelectorAll('.staff-account-box')).toHaveLength(2);
    expect(count()?.textContent).toBe('3');
  });

  it('shows no number without single access', () => {
    render(ACCOUNTS, 0);
    expect(count()).toBeNull();
  });

  it('shows only the number for a user without any account', () => {
    render([], 5);
    expect(container.querySelectorAll('.staff-account-box')).toHaveLength(0);
    expect(count()?.textContent).toBe('5');
  });
});
