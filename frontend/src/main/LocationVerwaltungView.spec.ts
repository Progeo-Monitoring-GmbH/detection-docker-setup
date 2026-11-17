import { describe, expect, it } from 'vitest';
import {
  accessUserLabel,
  pickableUsers,
  verwaltungKpis,
  verwaltungRowKey,
} from './LocationVerwaltungView';

const anna = {
  id: 1,
  username: 'anna',
  first_name: 'Anna',
  last_name: 'Berg',
  email: 'anna.berg@progeo.com',
};
const bob = {
  id: 2,
  username: 'bob',
  first_name: '',
  last_name: '',
  email: 'bob@progeo.com',
};
const carl = {
  id: 3,
  username: 'carl',
  first_name: 'Carl',
  last_name: 'Dorn',
  email: null,
};

describe('accessUserLabel', () => {
  it('shows the full name with the mail address', () => {
    expect(accessUserLabel(anna)).toBe('Anna Berg (anna.berg@progeo.com)');
  });

  it('falls back to the username without a name', () => {
    expect(accessUserLabel(bob)).toBe('bob (bob@progeo.com)');
    expect(accessUserLabel(carl)).toBe('Carl Dorn');
  });
});

describe('pickableUsers', () => {
  const users = [anna, bob, carl];

  it('leaves out users who already have access', () => {
    expect(
      pickableUsers(users, [{ user: 2 }], '').map((user) => user.id),
    ).toEqual([1, 3]);
  });

  it('filters by name, username and mail, ignoring case', () => {
    expect(pickableUsers(users, [], 'BERG').map((user) => user.id)).toEqual([
      1,
    ]);
    expect(pickableUsers(users, [], 'bob@').map((user) => user.id)).toEqual([
      2,
    ]);
    expect(pickableUsers(users, [], ' dorn ').map((user) => user.id)).toEqual([
      3,
    ]);
  });
});

describe('verwaltung rows', () => {
  it('keys a row by account and id - ids repeat across account databases', () => {
    expect(verwaltungRowKey({ account_id: 3, id: 17 })).toBe('3-17');
  });

  it('counts the KPIs over the rows loaded so far', () => {
    expect(
      verwaltungKpis([
        { status: 'ok' },
        { status: 'alarm' },
        { status: 'ok' },
        { status: 'kritisch' },
      ]),
    ).toEqual({ ok: 2, beobachten: 0, alarm: 1, kritisch: 1 });
  });
});
