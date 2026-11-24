// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { parseCoordinate } from './LocationStandortPanel';
import { onlineSince } from './LocationObjektTab';
import { mayAddPeople, mayEditRule, mayRevoke } from './LocationRechteTab';
import {
  locationConnectivity,
  locationState,
  OVERVIEW_ROWS_PER_PAGE,
} from './LocationsOverview';

const NOW = Date.parse('2026-11-17T12:00:00Z');

describe('parseCoordinate (Objekt tab, staff position)', () => {
  it('reads decimal degrees with a point or a comma', () => {
    expect(parseCoordinate('50.7374', 90)).toBe(50.7374);
    expect(parseCoordinate(' 7,0982 ', 180)).toBe(7.0982);
    expect(parseCoordinate('-33', 90)).toBe(-33);
  });

  it('is null when empty and NaN when it is no coordinate', () => {
    expect(parseCoordinate('', 90)).toBeNull();
    expect(parseCoordinate('91', 90)).toBeNaN();
    expect(parseCoordinate('50°44', 90)).toBeNaN();
    expect(parseCoordinate('1e2', 180)).toBeNaN();
  });
});

describe('onlineSince (Objekt tab)', () => {
  it('says never without any measurement', () => {
    expect(onlineSince(null, 'Nie', NOW)).toBe('Nie');
    expect(onlineSince(undefined, 'Nie', NOW)).toBe('Nie');
  });

  it('says how long ago the first measurement came in', () => {
    expect(onlineSince('2026-11-14T12:00:00Z', 'Nie', NOW)).toMatch(/3/);
    expect(onlineSince('2026-11-14T12:00:00Z', 'Nie', NOW)).not.toBe('Nie');
  });
});

describe('mayEditRule (Rechte tab)', () => {
  const base = {
    canEdit: false,
    viewerIsStaff: false,
    memberIsStaff: false,
    isOwn: false,
  };

  it('lets everyone change their own notifications', () => {
    expect(mayEditRule({ ...base, isOwn: true })).toBe(true);
  });

  it("needs the edit permission for other people's - and staff for a staff member's", () => {
    expect(mayEditRule(base)).toBe(false);
    expect(mayEditRule({ ...base, canEdit: true })).toBe(true);
    expect(mayEditRule({ ...base, canEdit: true, memberIsStaff: true })).toBe(
      false,
    );
    expect(
      mayEditRule({
        ...base,
        canEdit: true,
        memberIsStaff: true,
        viewerIsStaff: true,
      }),
    ).toBe(true);
  });
});

describe('mayAddPeople (Rechte tab)', () => {
  it('lets Kundenadmins and customer admins add people, never a plain Kundennutzer', () => {
    expect(mayAddPeople({ role: 'kundenadmin', isCustomerAdmin: false })).toBe(true);
    expect(mayAddPeople({ role: 'progeo-admin', isCustomerAdmin: false })).toBe(true);
    expect(mayAddPeople({ role: 'nutzer', isCustomerAdmin: true })).toBe(true);
    expect(mayAddPeople({ role: 'nutzer', isCustomerAdmin: false })).toBe(false);
  });
});

describe('mayRevoke (Rechte tab)', () => {
  const base = { isOwn: false, canEdit: false, canRevokeAccount: false };

  it('revokes single access with the edit permission or as a customer admin', () => {
    expect(mayRevoke({ ...base, access: 'single' })).toBe(false);
    expect(mayRevoke({ ...base, access: 'single', canEdit: true })).toBe(true);
    expect(
      mayRevoke({ ...base, access: 'single', canRevokeAccount: true }),
    ).toBe(true);
  });

  it('leaves another customer admin to staff', () => {
    const otherAdmin = {
      ...base,
      access: 'account' as const,
      canRevokeAccount: true,
      memberIsCustomerAdmin: true,
    };
    expect(mayRevoke(otherAdmin)).toBe(false);
    expect(mayRevoke({ ...otherAdmin, viewerIsStaff: true })).toBe(true);
  });

  it('takes account members out only as a customer admin - never oneself', () => {
    expect(mayRevoke({ ...base, access: 'account', canEdit: true })).toBe(
      false,
    );
    expect(
      mayRevoke({ ...base, access: 'account', canRevokeAccount: true }),
    ).toBe(true);
    expect(
      mayRevoke({
        ...base,
        access: 'account',
        canRevokeAccount: true,
        isOwn: true,
      }),
    ).toBe(false);
  });

  it('never revokes ProGeo staff', () => {
    expect(
      mayRevoke({
        access: 'staff',
        isOwn: false,
        canEdit: true,
        canRevokeAccount: true,
      }),
    ).toBe(false);
  });
});

describe('location overview state', () => {
  it('is online with a measurement within 24 h, offline with an older one', () => {
    expect(
      locationConnectivity(
        { last_measurement_at: '2026-11-17T08:00:00Z' },
        NOW,
      ),
    ).toBe('online');
    expect(
      locationConnectivity(
        { last_measurement_at: '2026-11-15T08:00:00Z' },
        NOW,
      ),
    ).toBe('offline');
    expect(locationConnectivity({ last_measurement_at: null }, NOW)).toBe(
      'none',
    );
  });

  it('colours a row with open alarms as alarm, whatever its connectivity', () => {
    const row = { last_measurement_at: '2026-11-17T08:00:00Z' };
    expect(locationState(row, { count: 2, active: 1 }, NOW)).toBe('alarm');
    expect(locationState(row, { count: 0, active: 0 }, NOW)).toBe('online');
    expect(locationState(row, undefined, NOW)).toBe('online');
  });

  it('shows 25 rows per page by default', () => {
    expect(OVERVIEW_ROWS_PER_PAGE).toBe(25);
  });
});
