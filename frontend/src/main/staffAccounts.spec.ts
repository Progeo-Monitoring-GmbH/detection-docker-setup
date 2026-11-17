import { describe, expect, it } from 'vitest';
import { ACCOUNT_COLORS, accountLegend, matchesAccountFilter, NO_ACCOUNT } from './staffAccounts';

const users = [
  { accounts: [{ id: 2, name: 'Zeta' }, { id: 1, name: 'Alpha' }] },
  { accounts: [{ id: 2, name: 'Zeta' }] },
  { accounts: [] },
  {},
];

describe('accountLegend', () => {
  it('lists every account once, by name, with its colour and member count', () => {
    expect(accountLegend(users)).toEqual([
      { id: 1, name: 'Alpha', count: 1, color: ACCOUNT_COLORS[0] },
      { id: 2, name: 'Zeta', count: 2, color: ACCOUNT_COLORS[1] },
    ]);
  });

  it('repeats the colours beyond the pool', () => {
    const many = Array.from({ length: ACCOUNT_COLORS.length + 1 }, (_, index) => ({
      accounts: [{ id: index + 1, name: `A${String(index).padStart(2, '0')}` }],
    }));
    const legend = accountLegend(many);
    expect(legend[ACCOUNT_COLORS.length].color).toBe(ACCOUNT_COLORS[0]);
  });
});

describe('matchesAccountFilter', () => {
  it('keeps everyone without a filter', () => {
    expect(users.every((user) => matchesAccountFilter(user, ''))).toBe(true);
  });

  it('keeps the members of the account', () => {
    expect(users.map((user) => matchesAccountFilter(user, '1'))).toEqual([true, false, false, false]);
    expect(users.map((user) => matchesAccountFilter(user, '2'))).toEqual([true, true, false, false]);
  });

  it('keeps the users without any account for NO_ACCOUNT', () => {
    expect(users.map((user) => matchesAccountFilter(user, NO_ACCOUNT))).toEqual([false, false, true, true]);
  });
});
