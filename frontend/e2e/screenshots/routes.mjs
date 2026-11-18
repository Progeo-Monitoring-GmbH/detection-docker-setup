// The screens the e2e_screenshots command captures (capture.mjs): every route
// of the app with the parameters that show something, and who sees it.
//
//   action  - the file name's last part: {pc|mobile}-{user|staff}-{action}.png
//   path    - opened as is (the mocked location is #1, escalation #1)
//   roles   - "user": a customer with the usual module permissions,
//             "staff": staff (and superuser - every page) - see mockApi.mjs
//   public  - opened without a login (captured once, as "user")

export const ROUTES = [
  // -- before the login -----------------------------------------------------------
  { action: 'login', path: '/login', roles: ['user'], public: true },
  { action: 'login-link', path: '/login/link', roles: ['user'], public: true },
  {
    action: 'forgot-password',
    path: '/forgot-password',
    roles: ['user'],
    public: true,
  },
  {
    action: 'access-request',
    path: '/access/request',
    roles: ['user'],
    public: true,
  },
  { action: 'privacy', path: '/privacy', roles: ['user'], public: true },

  // -- the locations ----------------------------------------------------------------
  {
    action: 'location-overview',
    path: '/location/overview/',
    roles: ['user', 'staff'],
  },
  {
    action: 'location-status',
    path: '/location/1/status',
    roles: ['user', 'staff'],
  },
  {
    action: 'location-status-timeseries',
    path: '/location/1/status?view=zeitreihe&range=7d',
    roles: ['user', 'staff'],
  },
  {
    action: 'location-analysis',
    path: '/location/1/analysis',
    roles: ['staff'],
  },
  {
    action: 'location-object',
    path: '/location/1/object',
    roles: ['user', 'staff'],
  },
  {
    action: 'location-notifications',
    path: '/location/1/notifications',
    roles: ['user', 'staff'],
  },
  {
    action: 'location-permissions',
    path: '/location/1/permissions',
    roles: ['user', 'staff'],
  },
  {
    action: 'location-settings',
    path: '/location/1/settings',
    roles: ['staff'],
  },
  {
    action: 'location-alarms',
    path: '/location/1/alarms',
    roles: ['user', 'staff'],
  },

  // -- staff ------------------------------------------------------------------------
  { action: 'management', path: '/management/', roles: ['staff'] },
  { action: 'create-location', path: '/create/', roles: ['staff'] },
  { action: 'checklist', path: '/checklist/location/', roles: ['staff'] },
  {
    action: 'checklist-location',
    path: '/checklist/location/?location=1',
    roles: ['staff'],
  },
  { action: 'alarms', path: '/alarms/', roles: ['staff'] },
  { action: 'alarm-report', path: '/alarms/report/', roles: ['staff'] },
  { action: 'escalations', path: '/escalations/', roles: ['staff'] },
  { action: 'escalation-detail', path: '/escalations/1', roles: ['staff'] },
  { action: 'device-overview', path: '/device/overview', roles: ['staff'] },
  {
    action: 'device-statistics',
    path: '/device/statistics/',
    roles: ['staff'],
  },
  {
    action: 'site-plan-wizard',
    path: '/site-plan/wizard/?location=1',
    roles: ['staff'],
  },
  { action: 'map', path: '/map/', roles: ['staff'] },
  { action: 'staff-admin', path: '/staff/', roles: ['staff'] },
  {
    action: 'insights-databases',
    path: '/insights/databases/',
    roles: ['staff'],
  },
  {
    action: 'insights-activity',
    path: '/insights/activity/',
    roles: ['staff'],
  },
  { action: 'interface', path: '/interface/', roles: ['staff'] },
  { action: 'backup', path: '/backup/1/overview/', roles: ['staff'] },
  { action: 'admin-panel', path: '/admin/panel/', roles: ['staff'] },
  { action: 'developer', path: '/developer', roles: ['staff'] },
  { action: 'screen-review', path: '/review/screens/', roles: ['staff'] },
];
