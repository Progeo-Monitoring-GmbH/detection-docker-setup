import { describe, expect, it } from 'vitest';
import coreRoutesSource from '../CoreRoutes.jsx?raw';
import {
  APP_ROUTE_ACCESS,
  CUSTOMER_ADMIN,
  type AccessContext,
  portalItemRule,
  routeRule,
  staffFlags,
} from './access';
import { PORTAL_NAV_ITEMS } from './portalNav';

const ALL = () => true;
const NONE = () => false;

/** A customer who was given every module permission - still no staff. */
const PLAIN_WITH_ALL_PERMISSIONS: AccessContext = {
  isStaff: false,
  isSuperuser: false,
  hasPermission: ALL,
};
const STAFF_WITHOUT_PERMISSIONS: AccessContext = {
  isStaff: true,
  isSuperuser: false,
  hasPermission: NONE,
};
// usePermissions: hasPermission is always true for a superuser.
const SUPERUSER: AccessContext = {
  isStaff: false,
  isSuperuser: true,
  hasPermission: ALL,
};

const allowed = (access: AccessContext) =>
  Object.keys(APP_ROUTE_ACCESS)
    .filter((path) => routeRule(path)(access))
    .sort();

describe('APP_ROUTE_ACCESS', () => {
  it('opens no staff page to a non-staff user, whatever permissions they hold', () => {
    expect(allowed(PLAIN_WITH_ALL_PERMISSIONS)).toEqual(
      [
        '*',
        '/alarms/',
        '/alarms/report/',
        '/device/:id/update/',
        '/device/overview',
        '/location/overview/',
        '/interface/',
        // As a customer admin: the users table of their own account.
        '/staff/',
      ].sort(),
    );
  });

  it('opens /staff/ to a customer admin - not to staff without the staff permission', () => {
    const customerAdmin: AccessContext = {
      isStaff: false,
      isSuperuser: false,
      hasPermission: (code) => code === 'module_customer_admin_enabled',
    };
    expect(allowed(customerAdmin)).toEqual(['*', '/device/:id/update/', '/staff/']);
    expect(CUSTOMER_ADMIN(customerAdmin)).toBe(true);
    // Staff are no customer admins: /staff/ needs their own permission.
    const staffWithIt: AccessContext = { ...customerAdmin, isStaff: true };
    expect(CUSTOMER_ADMIN(staffWithIt)).toBe(false);
    expect(routeRule('/staff/')(staffWithIt)).toBe(false);
  });

  it('only opens staff pages with their matching module permission', () => {
    expect(allowed(STAFF_WITHOUT_PERMISSIONS)).toEqual(
      [
        '*',
        '/checklist/location/',
        '/device/:id/update/',
        '/device/overview',
        '/site-plan/wizard/',
        '/map/',
      ].sort(),
    );

    const staffWithModulePermissions: AccessContext = {
      isStaff: true,
      isSuperuser: false,
      hasPermission: (code) =>
        [
          'module_admin_panel',
          'module_admin_staff_enabled',
          'module_admin_insights',
          'module_admin_screen_review',
          'module_admin_thresholds',
          'module_escalations_enabled',
        ].includes(code),
    };
    const visible = allowed(staffWithModulePermissions);
    expect(visible).toContain('/admin/panel/');
    expect(visible).toContain('/staff/');
    expect(visible).toContain('/insights/activity/');
    expect(visible).toContain('/insights/databases/');
    expect(visible).toContain('/review/screens/');
    expect(visible).toContain('/staff/thresholds/');
    expect(visible).toContain('/escalations/');
    expect(visible).toContain('/escalations/:id');
  });

  it('opens every page to a superuser', () => {
    expect(allowed(SUPERUSER)).toEqual(Object.keys(APP_ROUTE_ACCESS).sort());
  });

  it('lets nobody in on a path without a rule', () => {
    expect(routeRule('/not/listed/')(SUPERUSER)).toBe(false);
  });
});

describe('portalItemRule', () => {
  it('keeps "Einstellungen" superuser-only', () => {
    const einstell = PORTAL_NAV_ITEMS.find((item) => item.key === 'einstell')!;
    expect(portalItemRule(einstell)(PLAIN_WITH_ALL_PERMISSIONS)).toBe(false);
    expect(portalItemRule(einstell)(STAFF_WITHOUT_PERMISSIONS)).toBe(false);
    expect(portalItemRule(einstell)(SUPERUSER)).toBe(true);
  });

  it('keeps the "Analyse" staff-only, also for customers holding its permission', () => {
    const analyse = PORTAL_NAV_ITEMS.find((item) => item.key === 'analyse')!;
    expect(portalItemRule(analyse)(PLAIN_WITH_ALL_PERMISSIONS)).toBe(false);
    expect(portalItemRule(analyse)(STAFF_WITHOUT_PERMISSIONS)).toBe(false);
    expect(
      portalItemRule(analyse)({
        isStaff: true,
        isSuperuser: false,
        hasPermission: ALL,
      }),
    ).toBe(true);
    expect(portalItemRule(analyse)(SUPERUSER)).toBe(true);
  });

  it('gates the other items by their module permission', () => {
    PORTAL_NAV_ITEMS.filter(
      (item) => !['einstell', 'analyse'].includes(item.key),
    ).forEach((item) => {
      const only = (code: string) => code === item.permission;
      expect(
        portalItemRule(item)({
          isStaff: false,
          isSuperuser: false,
          hasPermission: only,
        }),
      ).toBe(true);
      expect(portalItemRule(item)(STAFF_WITHOUT_PERMISSIONS)).toBe(false);
    });
  });
});

describe('staffFlags', () => {
  it('reads the JWT flags and treats is_staff and is_superuser apart', () => {
    expect(staffFlags(null)).toEqual({
      isStaff: false,
      isSuperuser: false,
      isStaffOrSuperuser: false,
    });
    expect(staffFlags({ is_staff: true })).toEqual({
      isStaff: true,
      isSuperuser: false,
      isStaffOrSuperuser: true,
    });
    expect(staffFlags({ is_superuser: true })).toEqual({
      isStaff: false,
      isSuperuser: true,
      isStaffOrSuperuser: true,
    });
  });
});

describe('CoreRoutes', () => {
  // The routes behind the login (PendingGate) - the public ones before it
  // need no guard.
  const gated = coreRoutesSource.slice(
    coreRoutesSource.indexOf('<Route element={<PendingGate />}>'),
  );
  // Whitespace dropped, so a wrapped `guard(\n'/path',` still matches.
  // A lookahead, so one route's text doesn't swallow the next route.
  const routes = [
    ...gated.matchAll(
      /<Route\s+path="([^"]+)"\s+element=\{(?=([\s\S]{0,160}))/g,
    ),
  ]
    .map(([, path, element]) => ({
      path,
      element: element.replace(/\s+/g, ''),
    }))
    // Children of a guarded parent (the developer tabs) are relative.
    .filter(({ path }) => path.startsWith('/') || path === '*');
  const guarded = [...gated.matchAll(/guard\(\s*'([^']+)'/g)].map(
    ([, path]) => path,
  );

  it('finds the routes', () => {
    expect(routes.length).toBeGreaterThan(20);
  });

  it.each(routes.map((route) => [route.path, route] as const))(
    '%s is guarded by its own rule or only redirects',
    (path, { element }) => {
      const redirectOnly = /^<Navigateto=|^<RedirectToStatus\/>/.test(element);
      expect(
        redirectOnly || element.startsWith(`guard('${path}',`),
        `${path}: wrap it in guard('${path}', ...) and add a rule to APP_ROUTE_ACCESS`,
      ).toBe(true);
    },
  );

  it('guards the portal pages with GuardedPortalPage', () => {
    expect(gated).toMatch(
      /path=\{`\/location\/:id\/\$\{item\.segment\}`\}\s+element=\{\s+<GuardedPortalPage/,
    );
  });

  it('has a rule for every guarded path and no rule without a route', () => {
    expect(new Set(guarded)).toEqual(new Set(Object.keys(APP_ROUTE_ACCESS)));
  });
});
