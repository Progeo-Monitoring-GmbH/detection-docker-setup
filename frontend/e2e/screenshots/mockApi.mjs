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
  // A merged project (helper/location_merge.py): #4739 groups #4700 and #4701.
  parent_location: index < 2 ? 40 : null,
  part_count: index === 39 ? 2 : 0,
}));
locations[39].name = 'Werk Köln (Projektverbund)';

/** GET /v1/location-selection/group/: the merged project of the opened location. */
const locationGroup = () => ({
  group: {
    parent: {
      id: 40,
      name: locations[39].name,
      project_id: locations[39].project_id,
    },
    parts: locations.slice(0, 2).map((row, index) => ({
      id: row.id,
      name: row.name,
      project_id: row.project_id,
      lageplans: [
        { id: 100 + index, name: index ? 'Halle 2 EG' : 'Hauptgebäude' },
      ],
    })),
  },
  can_dissolve: true,
});

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
    // Ends close to the others (the end labels must not overlap) and fixes
    // today (the "today" donut).
    ...[
      [
        3,
        'j.klein',
        [
          [10, 9],
          [6, 6.3],
          [0.2, 8.1],
        ],
      ],
      [
        4,
        'm.schulz',
        [
          [4, 2.7],
          [0.1, 2.7],
        ],
      ],
      [
        5,
        'l.wolf',
        [
          [8, 3.6],
          [0.3, 1.8],
        ],
      ],
    ].map(([id, username, fixes]) => ({
      id,
      username,
      total:
        Math.round(fixes.reduce((sum, [, points]) => sum + points, 0) * 10) /
        10,
      count: fixes.length,
      awards: fixes.map(([daysAgo, points], index) => ({
        at: iso(NOW - daysAgo * 24 * HOUR),
        points,
        check_key: index % 2 ? 'threshold' : 'lageplan',
        location_id: index + 2,
        project_id: 4701 + index,
        location_name: locations[index + 1].name,
      })),
    })),
  ].sort((a, b) => b.total - a.total), // ranked, like the backend
  unattributed: { total: 8.1, count: 2 },
  now: iso(NOW),
});

// -- data the dialogs (routes.mjs `modals`) need ----------------------------------

/** A stand-in QR code (a grey square). */
const QR_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNoAAAAggCBd81ytgAAAABJRU5ErkJggg==';

/** GET /v1/location/<id>/access/: members (Rechte) and rules (Einstellungen, Verwaltung). */
const locationAccess = () => ({
  access: [
    {
      id: 11,
      user: 1,
      user_name: 'Jonas Weber',
      user_email: 'staff.weber@progeo.com',
      is_staff: true,
      objektleitung: true,
      transport: 1,
      type: 1,
    },
    {
      id: 12,
      user: 7,
      user_name: 'Tom Becker',
      user_email: 't.becker@progeo.com',
      is_staff: false,
      objektleitung: false,
      transport: 1,
      type: 1,
    },
  ],
  members: [
    {
      user_id: 2,
      username: 'kunde.mueller',
      full_name: 'Maria Müller',
      email: 'kunde.mueller@progeo.com',
      mobile: null,
      messenger: null,
      last_login: iso(NOW - 5 * HOUR),
      access: 'account',
      single: false,
      rule: null,
    },
    {
      user_id: 7,
      username: 't.becker',
      full_name: 'Tom Becker',
      email: 't.becker@progeo.com',
      mobile: null,
      messenger: null,
      last_login: iso(NOW - 30 * HOUR),
      access: 'single',
      single: true,
      rule: { id: 12, user: 7, transport: 1, type: 1, objektleitung: false },
    },
  ],
  users: [],
  staff_users: [],
  can_invite: true,
});

/** The device of location #1 (device list, test measurements, commands). */
const device = {
  id: 1,
  location: 1,
  raw_hash: '4700-01',
  display_name: 'smartex dm Keller',
  type: 'smartbox',
  model: 'smartex dm',
  hardware: 'smartbox v3',
  version: '3.4.1',
  mac: 'A4:CF:12:9B:00:01',
  last_measurement_at: iso(NOW - HOUR),
  last_seen_at: iso(NOW - 0.2 * HOUR),
  online: true,
  hash_kind: 'project',
  ip: null,
  ping: null,
  notify_on_measurements: false,
};

/** Hourly measurements of location #1: EP and WP of 12 sensors each. */
const measurements = Array.from({ length: 48 }, (_, index) => ({
  id: 9000 + index,
  device: 1,
  last_fetched: iso(NOW - (48 - index) * HOUR),
  samples: Array.from(
    { length: SENSORS * 2 },
    (_, sensor) =>
      Math.round(
        (30 + (sensor % SENSORS) * 5 + 8 * Math.sin(index / 5 + sensor)) * 10,
      ) / 10,
  ),
}));

/** A suspected leak at sensor 6 of location #1, not acknowledged yet. */
const suspicionClusters = [
  {
    id: 'sensor-6',
    sensor_id: 6,
    device_ids: [1],
    device_label: 'smartex dm Keller',
    device_type: 'smartbox',
    alarm_ids: [1, 4],
    state: 'neu',
    active: true,
    severity: 'alarm',
    max_value: 147,
    since: iso(NOW - 30 * HOUR),
    resolved_at: null,
    ack_by: null,
    ack_at: null,
    pending_ack_alarm_ids: [1, 4],
    alarms: [
      { id: 1, triggered_at: iso(NOW - 30 * HOUR), value: 132, state: 'neu' },
      { id: 4, triggered_at: iso(NOW - 9 * HOUR), value: 147, state: 'neu' },
    ],
  },
];

/** The same leak as a computed point (mx-PEEL). */
const computedPoints = [
  {
    id: 'point-1',
    x: 0.44,
    y: 0.5,
    lageplan: null,
    strength: 1,
    sensor_ids: [6, 7],
    state: 'neu',
    active: true,
    severity: 'alarm',
    max_value: 147,
    max_exceedance: 47,
    first_seen: iso(NOW - 30 * HOUR),
    last_seen: iso(NOW - HOUR),
    readings: 18,
    alarm_ids: [1, 4],
    pending_ack_alarm_ids: [1, 4],
    x_m: null,
    y_m: null,
  },
];

const notificationCase = {
  id: 1,
  kind: 'offline',
  state: 'open',
  phase: 'notified',
  stage: 1,
  stages: 3,
  location_id: 1,
  project_id: 4700,
  location_name: locations[0].name,
  opened_at: iso(NOW - 26 * HOUR),
  last_contact_at: iso(NOW - 20 * HOUR),
  next_contact_at: iso(NOW + 4 * HOUR),
  muted: false,
  muted_until: null,
  unreachable_since: null,
  acknowledged_at: null,
  escalation_id: null,
  resolved_at: null,
  resolution: '',
  back_since: null,
  devices: [
    {
      id: '4700-01',
      label: 'smartex dm Keller',
      last_seen: iso(NOW - 27 * HOUR),
      back_since: null,
    },
  ],
  alarm_count: 0,
  notified: ['kunde.mueller@progeo.com'],
  notifications_disabled: false,
};

const statisticsDevice = {
  id: 1,
  database: 'progeo_4700',
  raw_hash: '4700-01',
  display_name: 'smartex dm Keller',
  type: 'smartbox',
  hardware: 'smartbox v3',
  chip_id: 'A1B2C3',
  device_ip: null,
  location_id: 1,
  location_name: locations[0].name,
  project_id: 4700,
  last_measurement_at: iso(NOW - HOUR),
  measured_24h: true,
  missing_points: false,
  dead: false,
};
const deviceStatistics = () => ({
  cached: true,
  generated_at: iso(NOW - HOUR),
  totals: {
    devices: 2,
    locations: 1,
    with_chip_id: 2,
    without_chip_id: 0,
    measured_24h: 2,
    not_measured_24h: 0,
    missing_points: 0,
    dead: 0,
    unused_locations: 0,
    locations_missing_points: 0,
    locations_without_gps: 0,
  },
  by_type: [{ type: 'smartbox', label: 'smartex dm', count: 2 }],
  devices: {
    by_type: {
      smartbox: [
        statisticsDevice,
        {
          ...statisticsDevice,
          id: 2,
          raw_hash: '4700-02',
          display_name: 'smartex dm Halle',
        },
      ],
    },
    with_chip_id: [],
    without_chip_id: [],
    measured_24h: [],
    not_measured_24h: [],
    missing_points: [],
    dead: [],
  },
  locations: {},
});

/** A screen review run (the review page itself and its dialogs). */
const REVIEW_RUN = '2026-11-20_120000';
const reviewImage = {
  file: 'pc-user-de-login.png',
  device: 'pc',
  role: 'user',
  language: 'de',
  action: 'login',
  path: '/login',
  url: '/login',
  modal: null,
  viewport: [1440, 900],
  width: 1200,
  height: 800,
  errors: [],
};

/**
 * Variants of the data for one dialog's screenshot (routes.mjs `scenario`) -
 * the pages themselves keep the usual answers.
 */
export const SCENARIOS = {
  /** StaffMessaging: the circuit breaker stopped the SMS. */
  'breaker-tripped': {
    breaker: {
      tripped: true,
      tripped_at: iso(NOW - 2 * HOUR),
      reason: 'sms_per_hour',
    },
  },
  /** Location #1 as a smartex io project (climate panels instead of sensors). */
  smartexIo: { projectType: 10 },
  /** Location #1 as an mx-PEEL project (computed suspicion points). */
  'mx-peel': { projectType: 7 },
  /** The controller has a command waiting to be fetched (cancel dialog). */
  'pending-command': { pendingCommand: true },
};

/** The answer to an API request: a JSON body, or undefined (unmocked - {}). */
export const mockAnswer = (
  method,
  url,
  role,
  language = 'de',
  scenario = null,
) => {
  const { pathname, searchParams } = new URL(url);
  const persona = PERSONAS[role] ?? PERSONAS.user;
  const variant = (scenario && SCENARIOS[scenario]) || {};
  const ids = (searchParams.get('ids') || '')
    .split(',')
    .filter(Boolean)
    .map(Number);
  const path = pathname.replace(/\/+$/, '/');

  // -- dialogs' data (before the general answers below) ----------------------------
  if (/\/location\/\d+\/access\/$/.test(path)) {
    return locationAccess();
  }
  // "Mit Airtable abgleichen" (AirtableSyncButton): two projects without a location.
  if (path.endsWith('/device/provision/airtable/sync/')) {
    return {
      available: [
        {
          project_id: 4800,
          name: 'Halle 41 – Dachfläche A',
          airtable_type: 'dm',
          project_type_label: 'smartex® dm',
          status: 'Sensorik',
          product_sheets: [],
          airtable_url: null,
          raw_address: 'Industriestraße 41\n50707 Köln',
        },
        {
          project_id: 4801,
          name: 'Halle 42 – Dachfläche B',
          airtable_type: 'dm',
          project_type_label: 'smartex® dm',
          status: 'Technischer Planung',
          product_sheets: [],
          airtable_url: null,
          raw_address: 'Industriestraße 42\n50708 Berlin',
        },
      ],
      updated: [],
      unchanged: 38,
      signed: 'mock-signed',
      accounts: [{ id: 1, name: 'Kunde A' }],
    };
  }
  if (/\/location\/\d+\/devices\/names\/$/.test(path)) {
    return {
      devices: [
        {
          id: 1,
          name: 'Fühler Nord',
          hardware: 'lht65',
          type: 'smartex io',
          display_name: 'Fühler Nord',
        },
        {
          id: 2,
          name: '',
          hardware: 'lht65',
          type: 'smartex io',
          display_name: 'a84041000181c2b3',
        },
      ],
    };
  }
  if (/\/location\/\d+\/test_notification\/$/.test(path)) {
    return {
      recipients: [
        {
          user_id: 2,
          name: 'Maria Müller',
          mail: 'kunde.mueller@progeo.com',
          mobile: null,
          messenger: null,
          kanal: 'E-Mail',
        },
      ],
    };
  }
  if (/\/location\/\d+\/readiness\/airtable\/$/.test(path)) {
    return {
      airtable: {
        status: 'preview',
        project_id: 4700,
        fields: ['address'],
        changes: [
          {
            field: 'address',
            old: { value: 'Industriestraße 1', label: 'Industriestraße 1' },
            new: { value: 'Industriestraße 1a', label: 'Industriestraße 1a' },
          },
        ],
      },
    };
  }
  if (/\/location\/\d+\/measurements\/archive\/$/.test(path)) {
    return { total: 168, archived: 12 };
  }
  if (/\/location\/\d+\/measurements\/$/.test(path)) {
    return {
      measurements,
      total: measurements.length,
      devices: [{ id: 1, display_name: device.display_name }],
      device: 1,
    };
  }
  if (/\/location\/\d+\/noise-profiles\/suggest\/$/.test(path)) {
    return {
      mask_e: Array(SENSORS).fill(0),
      mask_w: Array(SENSORS).fill(0),
      source_from: iso(NOW - 7 * 24 * HOUR),
      source_to: iso(NOW),
      source_count: 168,
    };
  }
  if (/\/location\/\d+\/noise-profiles\/$/.test(path)) {
    return {
      profiles: [
        {
          id: 5,
          device: 1,
          name: 'Grundrauschen Oktober',
          mask_e: Array(SENSORS).fill(2),
          mask_w: Array(SENSORS).fill(3),
          sum_e: 24,
          sum_w: 36,
          source_from: iso(NOW - 40 * 24 * HOUR),
          source_to: iso(NOW - 33 * 24 * HOUR),
          source_count: 168,
          is_active: false,
          activated_at: null,
          created: iso(NOW - 30 * 24 * HOUR),
          updated: iso(NOW - 30 * 24 * HOUR),
          created_by: 'staff.weber',
        },
      ],
    };
  }
  if (path.endsWith('/status/location_devices/')) {
    return {
      location: { id: 1, project_id: 4700, name: locations[0].name },
      devices: [device],
      stats: {
        total: 1,
        online: 1,
        offline: 0,
        never_seen: 0,
        hash_kinds: { project: 1, mac: 0, legacy: 0 },
        ping: null,
      },
      pinged: false,
    };
  }
  if (path.endsWith('/device/provision/test-measurements/')) {
    return {
      measurements: [
        {
          id: 1,
          time: iso(NOW - 0.5 * HOUR),
          count: 16,
          max: 120,
          pairs: Array.from({ length: 16 }, (_, index) => [
            20 + index * 6,
            18 + index * 6,
          ]),
          check: {
            status: 'ok',
            rising: 16,
            start: 0,
            end: 15,
            mux: 1,
            noise: 0,
            noise_sensors: 0,
            quality: 98,
            outliers: [],
            reasons: [],
          },
          png: null,
        },
      ],
      expected_rising: 16,
      sensor_count: 16,
      mux_count: 1,
      pending_commands: [],
      last_command_poll: iso(NOW - 0.1 * HOUR),
    };
  }
  if (/\/device\/\d+\/commands\/$/.test(path)) {
    return {
      commands: [
        {
          id: 1,
          command: 'identify',
          status: 'success',
          created: iso(NOW - 3 * HOUR),
          sent_at: iso(NOW - 2.9 * HOUR),
          finished_at: iso(NOW - 2.9 * HOUR),
          created_by: 'staff.weber',
          summary: {},
          error: null,
          has_result: false,
        },
        {
          id: 2,
          command: 'set_params',
          status: 'failed',
          created: iso(NOW - 26 * HOUR),
          sent_at: iso(NOW - 25.9 * HOUR),
          finished_at: iso(NOW - 25.9 * HOUR),
          created_by: 'staff.weber',
          summary: { params: { interval: 3600 } },
          error: 'Gerät hat nicht geantwortet',
          has_result: false,
        },
        ...(variant.pendingCommand
          ? [
              {
                id: 3,
                command: 'restart',
                status: 'pending',
                created: iso(NOW - 0.1 * HOUR),
                sent_at: null,
                finished_at: null,
                created_by: 'staff.weber',
                summary: {},
                error: null,
                has_result: false,
              },
            ]
          : []),
      ],
      available: [
        'identify',
        'measure',
        'get_config',
        'restart',
        'set_params',
        'update',
      ].map((command) => ({
        command,
        superuser_only: command === 'update',
        allowed: true,
      })),
      pending_ttl_hours: 24,
      result_ttl_days: 7,
      last_command_poll: iso(NOW - 0.1 * HOUR),
    };
  }
  if (/\/device\/\d+\/firmware\/$/.test(path)) {
    return {
      current: '2026.09.1',
      bundles: [
        {
          id: '2026.09.1',
          release: '2026.09.1',
          firmware: '3.4.1',
          created: iso(NOW - 70 * 24 * HOUR),
          latest_in: [],
          remote: false,
          reason: 'current',
        },
        {
          id: '2026.11.0',
          release: '2026.11.0',
          firmware: '3.5.0',
          created: iso(NOW - 6 * 24 * HOUR),
          latest_in: ['smartbox'],
          remote: true,
          reason: null,
        },
      ],
      update: null,
    };
  }
  if (path.endsWith('/status/device_statistics/')) {
    return deviceStatistics();
  }
  if (path.endsWith('/status/measure_points/')) {
    return {
      lageplans: [
        {
          id: 100,
          name: 'Hauptgebäude',
          url: 'media/uploads/lageplan/plan-100.png',
          location_id: 1,
          is_active: true,
          offset_x: 0,
          offset_y: 0,
          scale_x: 1,
          scale_y: 1,
          flip_x: false,
          flip_y: false,
          meters_per_pixel: 0.05,
          heat_limitations: [
            {
              id: 'hl-1',
              name: 'Dachfläche Nord',
              points: [
                [0.08, 0.12],
                [0.62, 0.12],
                [0.62, 0.58],
                [0.08, 0.58],
              ],
            },
          ],
        },
      ],
      points: [
        // Device #1: a grid of points (a CAD import - replaced by a manual placement).
        ...sensorPoints.map((point, index) => ({
          id: index + 1,
          device: 1,
          sensor_order: point.pos,
          nx: point.x,
          ny: point.y,
          lageplan: 100,
        })),
        // Device #2: placed by hand (one point).
        {
          id: 50,
          device: 2,
          sensor_order: 1,
          nx: 0.82,
          ny: 0.74,
          lageplan: 100,
        },
      ],
      devices: [
        {
          id: 1,
          raw_hash: '4700-01',
          hardware: 'smartbox v3',
          type: 'smartbox',
          mac: device.mac,
          first_sensor_order: 1,
        },
        {
          id: 2,
          raw_hash: '4700-02',
          hardware: 'smartbox v3',
          type: 'smartbox',
          mac: 'A4:CF:12:9B:00:02',
          first_sensor_order: 13,
        },
      ],
    };
  }
  if (/\/v1\/\d+\/backup\/projects\/$/.test(path)) {
    return {
      projects: [
        { database: 'progeo_4700', project: 4700, name: locations[0].name },
      ],
    };
  }
  if (/\/v1\/\d+\/backup\/$/.test(path)) {
    return {
      elements: [1, 2].map((id) => ({
        id,
        name: `progeo_4700_2026-11-${String(20 - id).padStart(2, '0')}.sql.gz`,
        size: `${10 + id} MB`,
        is_compressed: true,
        created_at: iso(NOW - id * 24 * HOUR),
        database: 'progeo_4700',
        project: 4700,
        project_name: locations[0].name,
      })),
    };
  }
  if (path.endsWith('/database-usage/')) {
    return {
      cached: true,
      generated_at: iso(NOW - HOUR),
      stale_days: 30,
      split_enabled: true,
      default: { database: 'default', size_bytes: 52428800 },
      databases: [
        {
          database: 'progeo_4700',
          project: 4700,
          name: locations[0].name,
          size_bytes: 73400320,
          devices: 2,
          measurements: 4820,
          stats_at: iso(NOW - HOUR),
          last_measurement_at: iso(NOW - HOUR),
          status: 'active',
          error: null,
        },
        {
          database: 'progeo_4799',
          project: 4799,
          name: 'Altprojekt Lager Süd',
          size_bytes: 1048576,
          devices: 0,
          measurements: 0,
          stats_at: iso(NOW - HOUR),
          last_measurement_at: null,
          status: 'no_devices',
          error: null,
        },
      ],
    };
  }
  if (path.endsWith('/docker/status/')) {
    return {
      container: [
        {
          id: 'a1b2c3d4e5f60001',
          name: 'progeo-backend',
          status: 'running',
          image: 'progeo/backend:latest',
          started_at: iso(NOW - 50 * HOUR),
          health: 'healthy',
        },
        {
          id: 'a1b2c3d4e5f60002',
          name: 'progeo-worker-old',
          status: 'exited',
          image: 'progeo/worker:latest',
          started_at: null,
          health: null,
        },
      ],
    };
  }
  if (path.endsWith('/docker/logs/')) {
    return {
      logs: Array.from(
        { length: 30 },
        (_, index) =>
          `${iso(NOW - (30 - index) * 60000)} [INFO] worker ${index % 3}: request handled in ${20 + index} ms`,
      ).join('\n'),
    };
  }
  if (/\/staff\/users\/\d+\/password\/$/.test(path)) {
    return { username: 'nutzer2', new_password: 'Kx7-mPq2-Lr9w' };
  }
  if (path.endsWith('/staff/access-requests/')) {
    return {
      requests: [
        {
          id: 1,
          status: 'pending',
          first_name: 'Eva',
          last_name: 'Schmidt',
          company: 'Bau GmbH',
          email: 'eva.schmidt@progeo.com',
          phone: '',
          project: '4700',
          message: 'Ich bin die neue Objektleitung.',
          created: iso(NOW - 20 * HOUR),
          verified_at: iso(NOW - 19 * HOUR),
          reviewed_at: null,
          reviewed_by: null,
          review_note: '',
          user_id: 20,
          language: 'de',
        },
      ],
    };
  }
  if (path.endsWith('/location/accounts/')) {
    return {
      accounts: [
        { id: 1, name: 'Kunde A' },
        { id: 2, name: 'Kunde B' },
      ],
    };
  }
  if (path.endsWith('/location/project-search/')) {
    return { projects: [] };
  }
  if (/\/notification-case\/\d+\/$/.test(path)) {
    return {
      case: {
        ...notificationCase,
        events: [
          {
            id: 1,
            kind: 'notified',
            created: iso(NOW - 20 * HOUR),
            text: 'E-Mail an kunde.mueller@progeo.com',
            data: {},
          },
        ],
      },
    };
  }
  if (path.endsWith('/user/2fa/')) {
    return {
      enabled: persona.is_staff,
      required: persona.is_staff,
      recovery_codes_left: persona.is_staff ? 8 : 0,
      has_usable_password: true,
    };
  }
  if (path.endsWith('/screen-review/')) {
    return {
      runs: [
        { run: REVIEW_RUN, created: iso(NOW - 2 * HOUR), images: 1, notes: 1 },
      ],
      can_capture: true,
      can_fetch: false,
    };
  }
  if (path.endsWith(`/screen-review/${REVIEW_RUN}/`)) {
    return {
      run: REVIEW_RUN,
      images: [reviewImage],
      notes: [
        {
          id: 1,
          run: REVIEW_RUN,
          image: reviewImage.file,
          kind: 'area',
          action: 'bigger',
          comment: 'Anmeldeknopf größer',
          geometry: { x: 480, y: 420, w: 240, h: 60 },
          author: 1,
          author_name: 'Jonas Weber',
          created: iso(NOW - HOUR),
          updated: iso(NOW - HOUR),
        },
      ],
      reviewed: [],
      failures: [],
    };
  }

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
  if (path.endsWith('/location-selection/group/')) {
    // Only #1, #2 (the parts) and #40 (the merged project) are a group.
    const of = Number(searchParams.get('location')) || 1;
    return [1, 2, 40].includes(of)
      ? locationGroup()
      : { group: null, can_dissolve: false };
  }
  if (path.endsWith('/location-selection/users/')) {
    return {
      users: [
        { id: 2, name: 'Maria Müller', email: 'kunde.mueller@progeo.com' },
        { id: 7, name: 'Tom Becker', email: 't.becker@progeo.com' },
        { id: 8, name: null, email: 'objektleitung@progeo.com' },
      ],
    };
  }
  if (path.endsWith('/location-selection/project-id/')) {
    const nr = Number(searchParams.get('nr')) || null;
    return { nr, free: nr == null ? null : nr !== 4700, suggestion: 4740 };
  }
  if (path.endsWith('/location/min/')) {
    return role === 'user' ? locations.slice(0, 6) : locations;
  }
  if (path.endsWith('/location/map/')) {
    // The location map (/map/): every location at its city, a little apart -
    // activity at once, no chunks to load.
    const CITY_POINTS = {
      Köln: [50.94, 6.96],
      Berlin: [52.52, 13.4],
      Hamburg: [53.55, 9.99],
      München: [48.14, 11.58],
      Leipzig: [51.34, 12.37],
      Stuttgart: [48.78, 9.18],
    };
    const shown = role === 'user' ? locations.slice(0, 6) : locations;
    return {
      locations: shown.map((row) => {
        const [lat, lng] = CITY_POINTS[row.city];
        return {
          ...row,
          latitude: lat + (row.id % 5) * 0.03,
          longitude: lng + (row.id % 7) * 0.03,
          device_count: 1 + (row.id % 3),
          last_measurement_at: row.id % 4 ? iso(NOW - row.id * HOUR) : null,
        };
      }),
      activity: {},
      chunks: 0,
      databases: 0,
    };
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
        // The worst open severity or 'ok' - what admin_overview sends
        // (no 'offline': it showed as an untranslated ui_severity_ key).
        status: row.id % 5 ? 'ok' : 'beobachten',
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
  if (/\/location\/\d+\/$/.test(path)) {
    // #1 in full; another one (e.g. #3 - no escalation, no merged project) as itself.
    const id = Number(path.match(/\/location\/(\d+)\/$/)[1]);
    const shown =
      id === 1 || !locations[id - 1]
        ? detail
        : { ...detail, ...locations[id - 1] };
    return variant.projectType
      ? { ...shown, project_type: variant.projectType }
      : shown;
  }
  if (path.endsWith('/alarm/clusters/')) {
    return {
      clusters:
        Number(searchParams.get('location')) === 1 ? suspicionClusters : [],
    };
  }
  if (path.endsWith('/alarm/computed-clusters/')) {
    return {
      points: Number(searchParams.get('location')) === 1 ? computedPoints : [],
    };
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
    // The open escalation is #1's - another location has none.
    const of = Number(searchParams.get('location'));
    return { escalations: of && of !== 1 ? [] : [escalation] };
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
  if (path.endsWith('/favorite/')) {
    return { favorites: [] };
  }
  if (path.endsWith('/notification-case/timeline/')) {
    // /escalations/?view=flow: an alarm case after its first stage (one mail
    // bounced), the reminder in 1 h 40 min; an offline case before its notice.
    const people = [
      { name: 'Maria Müller', channels: ['mail', 'sms'], objektleitung: false },
      { name: 'Jonas Weber', channels: ['mail'], objektleitung: false },
      {
        name: 'Leitstand',
        channels: ['mail', 'messenger'],
        objektleitung: false,
      },
    ];
    const opened = NOW - 2.4 * HOUR;
    return {
      now: iso(NOW),
      run_minutes: 15,
      cases: [
        {
          id: 1,
          kind: 'alarm',
          phase: 'notified',
          location_id: 1,
          project_id: 4711,
          location_name: 'Halle Nord',
          location_missing: false,
          stage: 1,
          stages: 3,
          opened_at: iso(opened),
          alarm_count: 3,
          device_count: 0,
          muted_until: null,
          muted_forever: false,
          acknowledged_at: null,
          back_since: null,
          unreachable_since: null,
          escalation_id: null,
          next_at: iso(opened + 4 * HOUR),
          points: [
            { type: 'detected', at: iso(opened) },
            {
              type: 'sent',
              stage: 1,
              at: iso(opened + 3 * 60000),
              text: 'Stufe 1 versendet',
              sms: 1,
              messenger: 1,
              recipients: 3,
              withheld: false,
              escalation: false,
              objektleitung: false,
              mails: [
                {
                  name: 'Maria Müller',
                  address: 'maria.mueller@progeo.com',
                  status: 'sent',
                },
                {
                  name: 'Jonas Weber',
                  address: 'jonas.weber@progeo.com',
                  status: 'bounced',
                },
                {
                  name: 'Leitstand',
                  address: 'leitstand@progeo.com',
                  status: 'sent',
                },
              ],
            },
            {
              type: 'planned',
              stage: 2,
              due_at: iso(opened + 4 * HOUR),
              at: iso(opened + 4 * HOUR),
              overdue: false,
              paused: false,
              withheld: false,
              objektleitung: false,
              escalation: false,
              customer: true,
              recipients: people,
            },
            {
              type: 'planned',
              stage: 3,
              due_at: iso(opened + 24 * HOUR),
              at: iso(opened + 24 * HOUR),
              overdue: false,
              paused: false,
              withheld: false,
              objektleitung: true,
              escalation: true,
              customer: true,
              recipients: [
                ...people,
                {
                  name: 'Heike Schulz',
                  channels: ['mail'],
                  objektleitung: true,
                },
              ],
            },
          ],
          end: { kind: 'acknowledge', stable_hours: null },
        },
        {
          id: 2,
          kind: 'offline',
          phase: 'detected',
          location_id: 2,
          project_id: 4712,
          location_name: 'Lager Süd',
          location_missing: false,
          stage: 0,
          stages: 4,
          opened_at: iso(NOW - 6 * HOUR),
          alarm_count: 0,
          device_count: 2,
          muted_until: null,
          muted_forever: false,
          acknowledged_at: null,
          back_since: null,
          unreachable_since: null,
          escalation_id: null,
          next_at: iso(NOW + 16 * HOUR),
          points: [
            { type: 'detected', at: iso(NOW - 6 * HOUR) },
            ...[
              [1, 16, false],
              [2, 88, false],
              [3, 184, true],
            ].map(([stage, hours, lead]) => ({
              type: 'planned',
              stage,
              due_at: iso(NOW + hours * HOUR),
              at: iso(NOW + hours * HOUR),
              overdue: false,
              paused: false,
              withheld: false,
              objektleitung: lead,
              escalation: false,
              customer: true,
              recipients: [
                {
                  name: 'Lager Süd (Kontakt)',
                  channels: ['mail'],
                  objektleitung: false,
                },
              ],
            })),
            {
              type: 'planned',
              stage: 4,
              due_at: iso(NOW + 352 * HOUR),
              at: iso(NOW + 352 * HOUR),
              overdue: false,
              paused: false,
              withheld: false,
              objektleitung: false,
              escalation: true,
              customer: false,
              recipients: [],
            },
          ],
          end: { kind: 'back_online', stable_hours: 2 },
        },
      ],
    };
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
    return {
      cases: searchParams.get('state') === 'resolved' ? [] : [notificationCase],
    };
  }
  if (path.endsWith('/staff/messaging/')) {
    return {
      mailing_enabled: true,
      sms_dry_run: true,
      messenger_dry_run: false,
      breaker: variant.breaker ?? {
        tripped: false,
        tripped_at: null,
        reason: null,
      },
      limits: { mail_per_hour: 200, sms_per_hour: 50, sms_per_day: 300 },
      counts: {
        mail_last_hour: 12,
        sms_last_hour: 1,
        sms_today: 4,
        messenger_last_hour: 3,
        messenger_today: 9,
      },
      messages: [],
      suppressions: [
        {
          id: 1,
          address: 'alt.kunde@progeo.com',
          reason: 'hard bounce',
          bounce_count: 3,
          last_bounce_at: iso(NOW - 4 * 24 * HOUR),
          created: iso(NOW - 9 * 24 * HOUR),
        },
      ],
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
      // The messenger is offered (the notification channel's "Matrix" choice
      // and its setup dialog) - not connected yet.
      matrix: {
        user_id: `@${persona.username}:chat.progeo.com`,
        homeserver: 'https://chat.progeo.com',
        connected_at: null,
        primary: false,
        apps: {
          element_x: {
            link: 'https://chat.progeo.com/app/element',
            qr: QR_PNG,
          },
          fluffychat: {
            link: 'https://chat.progeo.com/app/fluffychat',
            qr: QR_PNG,
          },
        },
        download: {
          link: 'https://chat.progeo.com/download',
          qr: QR_PNG,
          stores: {
            ios: 'https://chat.progeo.com/download/ios',
            android: 'https://chat.progeo.com/download/android',
          },
        },
      },
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
  return undefined;
};
