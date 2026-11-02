// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  asNormalUser,
  isStaffAccount,
  readViewAsUser,
  storeViewAsUser,
} from './viewAsUser';

describe('viewAsUser', () => {
  afterEach(() => localStorage.clear());

  it('lets only staff and superusers switch', () => {
    expect(isStaffAccount({ is_staff: true })).toBe(true);
    expect(isStaffAccount({ is_superuser: true })).toBe(true);
    expect(isStaffAccount({ user_id: 1 })).toBe(false);
    expect(isStaffAccount(null)).toBe(false);
  });

  it('clears the staff flags and keeps the other claims', () => {
    const user = { user_id: 7, username: 'anna', is_staff: true, is_superuser: true };

    expect(asNormalUser(user)).toEqual({
      user_id: 7,
      username: 'anna',
      is_staff: false,
      is_superuser: false,
    });
    expect(user.is_superuser).toBe(true);
  });

  it('remembers the flag until it is switched off', () => {
    expect(readViewAsUser()).toBe(false);
    storeViewAsUser(true);
    expect(readViewAsUser()).toBe(true);
    storeViewAsUser(false);
    expect(readViewAsUser()).toBe(false);
  });
});
