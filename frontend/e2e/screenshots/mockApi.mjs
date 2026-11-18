// The mocked backend of the screenshots (capture.mjs answers every API request
// with mockAnswer). Deterministic demo data: 40 locations, location #1 with 12
// sensors and a week of hourly values, alarms, an escalation, staff users.
// A request without a mock gets {} - listed as "unmocked" in the run's
// manifest.json, so the screens to extend are easy to find.

const NOW = Date.now();
const HOUR = 3600 * 1000;
const iso = (ms) => new Date(ms).toISOString();

export const PERSONAS = {
  user: {
    user_id: 2,
    username: 'kunde.mueller',
    first_name: 'Maria',
    last_name: 'Müller',
    is_staff: false,
    is_superuser: false,
    permissions: [
      'module_navbar_enabled',
      'module_locations_enabled',
      'module_measurements_enabled',
      'module_devices_enabled',
      'module_notifications_enabled',
      'module_notifications_edit',
      'module_notifications_add',
      'module_profile_mail_edit',
    ],
  },
  staff: {
    user_id: 1,
    username: 'staff.weber',
    first_name: 'Jonas',
    last_name: 'Weber',
    // Superuser too: every page of the app gets its screenshot.
    is_staff: true,
    is_superuser: process.env.SCREENS_STAFF_SUPERUSER !== '0',
    permissions: [],
  },
};

const CITIES = ['Köln', 'Berlin', 'Hamburg', 'München', 'Leipzig', 'Stuttgart'];
const locations = Array.from({ length: 40 }, (_, index) => ({
  id: index + 1,
  project_id: 4700 + index,
  name:
    index === 0
      ? 'Logistikzentrum Nord'
      : `Halle ${index + 1} – Dachfläche ${String.fromCharCode(65 + (index % 6))}`,
  city: CITIES[index % CITIES.length],
  plz: String(50667 + index),
  address: `Industriestraße ${index + 1}`,
  project_type: index % 3 === 0 ? 1 : 2,
  readiness_score: 40 + ((index * 7) % 61),
  purgeable: index === 7 ? true : null,
  notifications_disabled: index === 5,
}));

const SENSORS = 12;
const sensorPoints = Array.from({ length: SENSORS }, (_, index) => ({
  pos: index + 1,
  x: 0.12 + (index % 4) * 0.25,
  y: 0.2 + Math.floor(index / 4) * 0.3,
  name: `Feld ${String.fromCharCode(65 + Math.floor(index / 4))}${(index % 4) + 1}`,
  lageplan: null,
  last_value: 20 + index * 6,
  threshold: null,
  disabled: index === 11,
  device: 1,
  pair: index + 1,
}));

const heatmap = (searchParams) => {
  const days = Number(searchParams.get('days')) || 7;
  const step = Number(searchParams.get('step')) || 3600;
  const frames = Math.min(Math.floor((days * 24 * HOUR) / (step * 1000)), 400);
  const timestamps = Array.from({ length: frames }, (_, index) =>
    Math.floor((NOW - (frames - index) * step * 1000) / 1000),
  );
  const data = Object.fromEntries(
    sensorPoints.map((point) => [
      String(point.pos),
      timestamps.map(
        (_, index) =>
          Math.round(
            (25 + point.pos * 4 + 30 * Math.sin(index / 9 + point.pos)) * 10,
          ) / 10,
      ),
    ]),
  );
  return {
    location: { ...detail, lageplans: [] },
    step,
    days,
    total: frames,
    timestamps,
    data,
    sensor_points: sensorPoints,
    lageplan: null,
    from: iso(NOW - days * 24 * HOUR),
    to: iso(NOW),
  };
};

const detail = {
  ...locations[0],
  country: 'DE',
  latitude: 50.94,
  longitude: 6.96,
  alarm_threshold: 100,
  device_count: 2,
  measurement_count: 4820,
  last_measurement_at: iso(NOW - HOUR),
  first_measurement_at: iso(NOW - 90 * 24 * HOUR),
  lageplans: [],
  language: 'de',
  manager: 'Max Mustermann',
  telefon: '+49 221 123456',
  mail: 'objekt@progeo.com',
  rain_check_enabled: true,
};

const alarms = Array.from({ length: 6 }, (_, index) => ({
  id: index + 1,
  status: index % 3 === 0 ? 1 : 0,
  threshold: 100,
  max_value: 120 + index * 9,
  triggered_at: iso(NOW - (index * 7 + 2) * HOUR),
  normalized_at: index % 2 ? iso(NOW - index * 7 * HOUR) : null,
  location: {
    id: locations[index].id,
    name: locations[index].name,
    project_id: locations[index].project_id,
  },
  device: { display_name: 'smartex dm Keller' },
  sensor_id: index + 1,
  sensor_max_values: [{ sensor_id: index + 1, value: 120 + index * 9 }],
  evaluated_by: index % 3 === 0 ? { username: 'staff.weber' } : null,
  evaluated_at: index % 3 === 0 ? iso(NOW - HOUR) : null,
}));

const escalation = {
  id: 1,
  location: 1,
  location_name: locations[0].name,
  project_id: 4700,
  title: 'Feuchtigkeit im Bereich B2',
  status: 'in_progress',
  assigned_to: 1,
  assigned_to_name: 'Jonas Weber',
  created_by: 1,
  created_by_name: 'Jonas Weber',
  created: iso(NOW - 48 * HOUR),
  updated: iso(NOW - 3 * HOUR),
  closed_at: null,
  closed_by: null,
  closed_by_name: null,
  entry_count: 3,
  view_state: {
    view: 'roof',
    range: '7d',
    at: iso(NOW - 30 * HOUR),
    sensor: 6,
  },
  entries: [
    {
      id: 1,
      kind: 'created',
      author: 1,
      author_name: 'Jonas Weber',
      text: 'Werte an B2 seit zwei Tagen über der Schwelle.',
      data: {},
      created: iso(NOW - 48 * HOUR),
    },
    {
      id: 2,
      kind: 'status',
      author: 1,
      author_name: 'Jonas Weber',
      text: '',
      data: { from: 'open', to: 'in_progress' },
      created: iso(NOW - 40 * HOUR),
    },
    {
      id: 3,
      kind: 'comment',
      author: 1,
      author_name: 'Jonas Weber',
      text: 'Termin mit dem Objektleiter am Freitag.',
      data: {},
      created: iso(NOW - 3 * HOUR),
    },
  ],
};

const staffUsers = Array.from({ length: 12 }, (_, index) => ({
  id: index + 1,
  username: index ? `nutzer${index}` : 'staff.weber',
  email: `nutzer${index}@progeo.com`,
  first_name: '',
  last_name: '',
  is_staff: index < 3,
  is_superuser: index === 0,
  is_active: index !== 9,
  date_joined: iso(NOW - (index + 3) * 24 * HOUR),
  last_login: iso(NOW - index * HOUR),
  two_factor_enabled: index < 3,
  logged_in: index < 2,
  last_activity: iso(NOW - index * HOUR),
  permissions: {},
  grantable: {},
  accounts: [{ id: 1 + (index % 2), name: index % 2 ? 'Kunde B' : 'Kunde A' }],
}));

const readinessChecks = [
  ['product', 'base', 3, 'pass'],
  ['address', 'base', 1, 'pass'],
  ['geo', 'base', 1, 'pass'],
  ['airtable', 'base', 1, 'fail'],
  ['lageplan', 'plan', 3, 'pass'],
  ['lageplan_aligned', 'plan', 2, 'fail'],
  ['heat_limitation', 'plan', 1, 'fail'],
  ['devices', 'devices', 3, 'pass'],
  ['devices_online', 'devices', 3, 'pass'],
  ['measure_points', 'points', 3, 'pass'],
  ['sensor_devices', 'points', 2, 'pass'],
  ['threshold', 'alarming', 2, 'pass'],
  ['users', 'alarming', 2, 'pass'],
  ['alarm_recipient', 'alarming', 2, 'fail'],
].map(([key, group, weight, status]) => ({
  key,
  group,
  weight,
  optional: key === 'airtable',
  status,
  values: {},
}));

const scoreboard = () => ({
  mean: Array.from({ length: 14 }, (_, index) => ({
    day: iso(NOW - (13 - index) * 24 * HOUR).slice(0, 10),
    score: 58 + index * 0.6,
    locations: 40,
  })),
  users: [
    {
      id: 1,
      username: 'staff.weber',
      total: 24.3,
      count: 4,
      awards: [8.1, 5.4, 2.7, 8.1].map((points, index) => ({
        at: iso(NOW - (12 - index * 3) * 24 * HOUR),
        points,
        check_key: 'lageplan',
        location_id: index + 1,
        project_id: 4700 + index,
        location_name: locations[index].name,
      })),
    },
    {
      id: 2,
      username: 'a.becker',
      total: 5.4,
      count: 1,
      awards: [
        {
          at: iso(NOW - 2 * 24 * HOUR),
          points: 5.4,
          check_key: 'threshold',
          location_id: 6,
          project_id: 4705,
          location_name: locations[5].name,
        },
      ],
    },
  ],
  unattributed: { total: 8.1, count: 2 },
  now: iso(NOW),
});

/** The answer to an API request: a JSON body, or undefined (unmocked - {}). */
export const mockAnswer = (method, url, role, language = 'de') => {
  const { pathname, searchParams } = new URL(url);
  const persona = PERSONAS[role] ?? PERSONAS.user;
  const ids = (searchParams.get('ids') || '')
    .split(',')
    .filter(Boolean)
    .map(Number);
  const path = pathname.replace(/\/+$/, '/');

  if (path.endsWith('/module-permissions/')) {
    const permissions = Object.fromEntries(
      persona.permissions.map((code) => [code, true]),
    );
    return {
      user_id: persona.user_id,
      username: persona.username,
      permissions,
      enabled: persona.permissions,
      activity_tracking: false,
    };
  }
  if (path.endsWith('/qa/notifications/')) {
    return { awards: [] };
  }
  if (path.endsWith('/qa/scoreboard/')) {
    return scoreboard();
  }
  if (path.endsWith('/location/min/')) {
    return role === 'user' ? locations.slice(0, 6) : locations;
  }
  if (path.endsWith('/location/details/')) {
    return ids.map((id) => ({
      ...locations[id - 1],
      measurement_count: 1200 + id,
      device_count: 1 + (id % 3),
      last_measurement_at: id % 4 ? iso(NOW - id * HOUR) : null,
    }));
  }
  if (path.endsWith('/location/flags/')) {
    return {
      flags: Object.fromEntries(
        locations.map((row) => [
          row.id,
          {
            notifications_disabled: row.notifications_disabled,
            purgeable: row.purgeable,
            readiness_score: row.readiness_score,
          },
        ]),
      ),
    };
  }
  if (path.endsWith('/alarm/location_summary/')) {
    return {
      locations: { 1: { count: 4, active: 1 }, 3: { count: 2, active: 2 } },
    };
  }
  if (path.endsWith('/location/admin_overview/')) {
    return {
      objects: locations.map((row) => ({
        ...row,
        account_id: 1,
        owner: 'Kunde A',
        status: row.id % 5 ? 'ok' : 'offline',
      })),
      kpis: {},
      count: locations.length,
      next_offset: null,
    };
  }
  if (path.endsWith('/location/readiness/')) {
    return {
      locations: locations.map((row) => ({
        ...row,
        score: row.readiness_score,
        level: row.readiness_score >= 80 ? 'almost' : 'progress',
        at: iso(NOW - HOUR),
        failed: ['lageplan_aligned', 'alarm_recipient'],
      })),
    };
  }
  if (/\/location\/\d+\/readiness\/$/.test(path)) {
    return {
      location: {
        id: 1,
        project_id: 4700,
        name: locations[0].name,
        purgeable: null,
      },
      score: 72,
      level: 'progress',
      at: iso(NOW),
      checks: readinessChecks,
      qa: [],
    };
  }
  if (/\/location\/\d+\/heatmap\/$/.test(path)) {
    return heatmap(searchParams);
  }
  if (/\/location\/\d+\/measurement-range\/$/.test(path)) {
    return {
      first: iso(NOW - 90 * 24 * HOUR),
      last: iso(NOW - HOUR),
      count: 4820,
      next: iso(NOW + HOUR),
    };
  }
  if (/\/location\/\d+\/access\/$/.test(path)) {
    return {
      access: [],
      members: [
        {
          id: 2,
          username: 'kunde.mueller',
          email: 'kunde@progeo.com',
          objektleitung: true,
        },
      ],
      users: [],
      staff_users: [],
      can_invite: true,
    };
  }
  if (/\/location\/\d+\/$/.test(path)) {
    return detail;
  }
  if (
    path.endsWith('/alarm/clusters/') ||
    path.endsWith('/alarm/computed-clusters/')
  ) {
    return { clusters: [], points: [] };
  }
  if (path.endsWith('/alarm/active/')) {
    return { alarms: alarms.filter((alarm) => alarm.status === 0) };
  }
  if (path.endsWith('/alarm/')) {
    return { alarms, rain_events: [] };
  }
  if (path.endsWith('/escalation/staff/')) {
    return {
      users: [
        { id: 1, name: 'Jonas Weber' },
        { id: 3, name: 'Anna Becker' },
      ],
    };
  }
  if (/\/escalation\/\d+\/$/.test(path)) {
    return { escalation };
  }
  if (path.endsWith('/escalation/')) {
    return { escalations: [escalation] };
  }
  if (path.includes('/staff/users/')) {
    return {
      scope: 'staff',
      grantable_codes: [],
      all_permission_defs: [],
      admin_accounts: [],
      users: staffUsers,
    };
  }
  if (path.endsWith('/staff/access-requests/')) {
    return { requests: [] };
  }
  if (path.endsWith('/favorite/')) {
    return { favorites: [] };
  }
  if (path.endsWith('/notification-case/summary/')) {
    const phases = {
      open: 3,
      detected: 1,
      notified: 1,
      reminder: 1,
      escalated: 0,
      recovering: 0,
      muted: 0,
      unreachable: 0,
    };
    return {
      counts: {
        offline: phases,
        alarm: { ...phases, open: 1, notified: 0, reminder: 0 },
      },
      locations: { disabled: 1, enabled: 39 },
      withheld_last_day: 0,
      resolved_last_day: { offline: 2, alarm: 1 },
      in_window: true,
      baseline_done: true,
      unsubscribed_last_week: 0,
      no_recipients_left: 0,
    };
  }
  if (path.endsWith('/notification-case/')) {
    return { cases: [] };
  }
  if (path.endsWith('/staff/messaging/')) {
    return {
      mailing_enabled: true,
      sms_dry_run: true,
      messenger_dry_run: false,
      breaker: { tripped: false, tripped_at: null, reason: null },
      limits: { mail_per_hour: 200, sms_per_hour: 50, sms_per_day: 300 },
      counts: {
        mail_last_hour: 12,
        sms_last_hour: 1,
        sms_today: 4,
        messenger_last_hour: 3,
        messenger_today: 9,
      },
      messages: [],
      suppressions: [],
    };
  }
  if (path.endsWith('/activity/messaging/')) {
    const window = {
      login: 4,
      invite: 1,
      reset: 0,
      matrix: 2,
      migration: 0,
      total: 7,
    };
    return {
      matrix: {
        enabled: true,
        server_accounts: 18,
        connected: 11,
        active_7d: 6,
        active_30d: 9,
        primary: 4,
      },
      login_links: { '24h': window, '7d': window, '30d': window },
    };
  }
  if (path.endsWith('/activity/sessions/')) {
    return {
      days: 30,
      enabled: true,
      retention_days: 180,
      limit: 200,
      sessions: [],
    };
  }
  if (path.endsWith('/activity/summary/')) {
    return { days: 30, enabled: true, pages: [], users: 0, sessions: 0 };
  }
  if (path.endsWith('/user/profile/')) {
    return {
      id: persona.user_id,
      username: persona.username,
      first_name: persona.first_name,
      last_name: persona.last_name,
      email: `${persona.username}@progeo.com`,
      // The profile's language wins in the top bar - the run's one.
      language,
      language_saved: true,
    };
  }
  if (path.endsWith('/location/project-types/')) {
    return {
      project_types: [
        { value: 1, label: 'smartex® dm' },
        { value: 2, label: 'smartex® mx-PEEL' },
      ],
    };
  }
  if (path.endsWith('/screen-review/')) {
    return { runs: [] };
  }
  return undefined;
};
