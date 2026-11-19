import type { TFunction } from 'i18next';

/**
 * The readiness scoreboard (GET /v1/qa/scoreboard/, backend
 * helper/readiness_qa.py): every staff member's fixed checks and the daily
 * mean score of all locations.
 */

export type QaAward = {
  at: string;
  points: number;
  check_key: string;
  location_id: number;
  project_id: number | null;
  location_name: string;
};

export type QaUser = {
  id: number;
  username: string;
  total: number;
  count: number;
  awards: QaAward[];
};

export type QaMeanDay = { day: string; score: number; locations: number };

export type Scoreboard = {
  mean: QaMeanDay[];
  users: QaUser[];
  unattributed: { total: number; count: number };
  now: string;
};

/** A fix as POST /v1/qa/notifications/ reports it (the toast). */
export type QaNotification = {
  id: number;
  check_key: string;
  points: number;
  location_id: number;
  project_id: number | null;
  location_name: string;
};

/**
 * Categorical hues for the staff lines, in this fixed order (validated for
 * colour-vision deficiencies on the white plot) - never cycled: staff beyond
 * the eighth share the neutral OTHER_COLOR and are told apart by name.
 */
export const SERIES_COLORS = [
  '#2a78d6',
  '#eb6834',
  '#1baf7a',
  '#eda100',
  '#e87ba4',
  '#008300',
  '#6250d6',
  '#e34948',
];
export const OTHER_COLOR = '#9b9590';
/** The overall line: one series in its own panel - ink, not a series hue. */
export const MEAN_COLOR = '#094b81';

/**
 * The colour of each staff member with points - by user id, so a colour stays
 * with its person when the ranking changes.
 */
export const userColors = (users: QaUser[]): Map<number, string> =>
  new Map(
    users
      .filter((user) => user.count > 0)
      .map((user) => user.id)
      .sort((a, b) => a - b)
      .map((id, index) => [id, SERIES_COLORS[index] ?? OTHER_COLOR]),
  );

/** Where the time axis starts: the first day with a mean score or the first fix. */
export const scoreboardStart = (board: Scoreboard): string => {
  const candidates = [
    ...board.mean.map((day) => `${day.day}T00:00:00`),
    ...board.users.flatMap((user) => user.awards.map((award) => award.at)),
  ].map((value) => new Date(value).getTime());
  const first = candidates.length
    ? Math.min(...candidates)
    : new Date(board.now).getTime();
  return new Date(first).toISOString();
};

export type CumulativeLine = {
  x: string[];
  y: number[];
  awards: (QaAward | null)[];
};

/**
 * A staff member's running total as the points of a step line: 0 at `start`,
 * up by each fix's points at its time, held until `end`. `awards[i]` is the
 * fix of point i (null for the start and end points) - the hover text.
 */
export const cumulativeLine = (
  awards: QaAward[],
  start: string,
  end: string,
): CumulativeLine => {
  const sorted = [...awards].sort(
    (a, b) => new Date(a.at).getTime() - new Date(b.at).getTime(),
  );
  const line: CumulativeLine = { x: [start], y: [0], awards: [null] };
  let total = 0;
  for (const award of sorted) {
    total += award.points;
    line.x.push(award.at);
    line.y.push(Math.round(total * 10) / 10);
    line.awards.push(award);
  }
  line.x.push(end);
  line.y.push(Math.round(total * 10) / 10);
  line.awards.push(null);
  return line;
};

/** A staff member's running total at `time` (fixes up to and including it). */
export const totalAt = (awards: QaAward[], time: number): number =>
  Math.round(
    awards
      .filter((award) => new Date(award.at).getTime() <= time)
      .reduce((sum, award) => sum + award.points, 0) * 10,
  ) / 10;

/**
 * A smooth curve through the points (x ascending): monotone cubic Hermite
 * (Fritsch-Carlson), `samples` points per segment. Unlike a spline it never
 * overshoots - a running total never seems to dip, a flat stretch stays flat.
 */
export const smoothCurve = (
  xs: number[],
  ys: number[],
  samples = 12,
): { x: number[]; y: number[] } => {
  const n = xs.length;
  if (n < 3) {
    return { x: [...xs], y: [...ys] };
  }
  const h: number[] = [];
  const delta: number[] = [];
  for (let i = 0; i < n - 1; i += 1) {
    h.push(xs[i + 1] - xs[i]);
    delta.push(h[i] === 0 ? 0 : (ys[i + 1] - ys[i]) / h[i]);
  }
  const m: number[] = [delta[0]];
  for (let i = 1; i < n - 1; i += 1) {
    m.push(delta[i - 1] * delta[i] <= 0 ? 0 : (delta[i - 1] + delta[i]) / 2);
  }
  m.push(delta[n - 2]);
  for (let i = 0; i < n - 1; i += 1) {
    if (delta[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / delta[i];
    const b = m[i + 1] / delta[i];
    const s = a * a + b * b;
    if (s > 9) {
      const tau = 3 / Math.sqrt(s);
      m[i] = tau * a * delta[i];
      m[i + 1] = tau * b * delta[i];
    }
  }
  const out = { x: [xs[0]], y: [ys[0]] };
  for (let i = 0; i < n - 1; i += 1) {
    for (let step = 1; step <= samples; step += 1) {
      const t = step / samples;
      const t2 = t * t;
      const t3 = t2 * t;
      out.x.push(xs[i] + t * h[i]);
      out.y.push(
        (2 * t3 - 3 * t2 + 1) * ys[i] +
          (t3 - 2 * t2 + t) * h[i] * m[i] +
          (-2 * t3 + 3 * t2) * ys[i + 1] +
          (t3 - t2) * h[i] * m[i + 1],
      );
    }
  }
  return out;
};

/**
 * The running total as a smooth line: it holds until shortly before each fix
 * and rises into it (soft steps - the points still come at the fix, not
 * spread over the days before it).
 */
export const smoothTotalLine = (
  awards: QaAward[],
  start: string,
  end: string,
): { x: number[]; y: number[] } => {
  const begin = new Date(start).getTime();
  const finish = Math.max(new Date(end).getTime(), begin);
  const rise = Math.max((finish - begin) / 12, 60_000);
  const times = [...awards]
    .map((award) => ({
      time: new Date(award.at).getTime(),
      points: award.points,
    }))
    .sort((a, b) => a.time - b.time);
  const xs = [begin];
  const ys = [0];
  let total = 0;
  for (const { time, points } of times) {
    const previous = xs[xs.length - 1];
    if (time > previous) {
      const hold = Math.max(time - rise, previous + (time - previous) / 2);
      if (hold > previous) {
        xs.push(hold);
        ys.push(total);
      }
    }
    total += points;
    if (time > xs[xs.length - 1]) {
      xs.push(time);
      ys.push(total);
    } else {
      ys[ys.length - 1] = total;
    }
  }
  if (finish > xs[xs.length - 1]) {
    xs.push(finish);
    ys.push(total);
  }
  return smoothCurve(xs, ys);
};

/**
 * End labels without overlap: `values` (pixels from the bottom) moved apart
 * to at least `gap`, within min..max, in their order. Returns the new
 * positions in the order given.
 */
export const spreadLabels = (
  values: number[],
  gap: number,
  min: number,
  max: number,
): number[] => {
  const order = values
    .map((value, index) => ({ value, index }))
    .sort((a, b) => a.value - b.value);
  const placed = order.map((entry) =>
    Math.min(Math.max(entry.value, min), max),
  );
  for (let i = 1; i < placed.length; i += 1) {
    placed[i] = Math.max(placed[i], placed[i - 1] + gap);
  }
  // Pushed over the top: back down from there.
  if (placed.length && placed[placed.length - 1] > max) {
    placed[placed.length - 1] = max;
    for (let i = placed.length - 2; i >= 0; i -= 1) {
      placed[i] = Math.min(placed[i], placed[i + 1] - gap);
    }
  }
  const result = new Array<number>(values.length);
  order.forEach((entry, position) => {
    result[entry.index] = placed[position];
  });
  return result;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** The scoreboard's days so far (start to now, at least one). */
export const scoreboardDays = (board: Scoreboard): number =>
  Math.max(
    1,
    Math.ceil(
      (new Date(board.now).getTime() -
        new Date(scoreboardStart(board)).getTime()) /
        DAY_MS,
    ),
  );

/** "⌀ daily gain": a staff member's points per day of the scoreboard. */
export const dailyGain = (user: QaUser, days: number): number =>
  Math.round((user.total / Math.max(days, 1)) * 100) / 100;

const localDay = (value: string | Date) => {
  const date = new Date(value);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
};

/** The points a staff member gained on the day of `now` (local time). */
export const pointsOnDay = (user: QaUser, now: string): number => {
  const day = localDay(now);
  return (
    Math.round(
      user.awards
        .filter((award) => localDay(award.at) === day)
        .reduce((sum, award) => sum + award.points, 0) * 10,
    ) / 10
  );
};

const pointsFormat = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 1,
});

export const formatPoints = (points: number) => pointsFormat.format(points);

const scoreFormat = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/** A mean score (or its change, `signed`) with one decimal - "64,0", "+2,5", "−1,2". */
export const formatScore = (score: number, signed = false) => {
  const text = scoreFormat.format(Math.abs(score));
  if (!signed) {
    return score < 0 ? `−${text}` : text;
  }
  return `${score < 0 ? '−' : '+'}${text}`;
};

/**
 * The mean panel's range: the scores' span with some room, within 0..100 -
 * the development stays visible instead of a flat line across 0..100.
 */
export const meanRange = (scores: number[]): [number, number] => {
  if (!scores.length) {
    return [0, 100];
  }
  const low = Math.min(...scores);
  const high = Math.max(...scores);
  const pad = Math.max((high - low) * 0.25, 2);
  return [
    Math.max(0, Math.floor(low - pad)),
    Math.min(100, Math.ceil(high + pad)),
  ];
};

/** "Lageplan aligned · Halle 1 (#4700)" - the check and its location. */
export const awardLabel = (
  t: TFunction,
  award: Pick<
    QaAward,
    'check_key' | 'location_name' | 'project_id' | 'location_id'
  >,
) =>
  `${t(`readiness_check_${award.check_key}`)} · ${award.location_name || t('qa_unnamed_location')} (#${award.project_id ?? award.location_id})`;

/** The toast text for fixes just credited to the user. */
export const awardToastText = (
  t: TFunction,
  awards: QaNotification[],
): string => {
  const points = formatPoints(
    awards.reduce((sum, award) => sum + award.points, 0),
  );
  if (awards.length === 1) {
    return t('qa_toast_one', { points, fix: awardLabel(t, awards[0]) });
  }
  return t('qa_toast_many', { points, count: awards.length });
};

/** A readiness check was answered (checklist) - the toasts look for new fixes now. */
export const QA_CHECKED_EVENT = 'progeo:qa-checked';

/** The websocket of the scoreboard's point changes (backend QaScoreboardConsumer, staff). */
export const QA_SOCKET_PATH = '/ws/qa/';

/** Points were gained or given back (QaAwardToasts passes the socket's message on) - the scoreboard reloads. */
export const QA_UPDATED_EVENT = 'progeo:qa-updated';

export type QaUpdate = { user_ids: number[]; reason: 'award' | 'revoke' };

/** A "qa_update" message of the socket - null for anything else (heartbeats). */
export const parseQaUpdate = (raw: unknown): QaUpdate | null => {
  if (typeof raw !== 'string') {
    return null;
  }
  try {
    const data = JSON.parse(raw) as {
      type?: string;
      user_ids?: unknown;
      reason?: unknown;
    };
    if (data.type !== 'qa_update') {
      return null;
    }
    const userIds = Array.isArray(data.user_ids)
      ? data.user_ids.filter((id): id is number => typeof id === 'number')
      : [];
    return {
      user_ids: userIds,
      reason: data.reason === 'revoke' ? 'revoke' : 'award',
    };
  } catch {
    return null;
  }
};

/** What POST /v1/location/<id>/purgeable/ did on the scoreboard. */
export type PurgeableQa =
  { awarded?: QaNotification; revoked?: number } | null | undefined;

/**
 * After a purgeable flag was changed: points gained come as the usual toast
 * (QaAwardToasts, asked right away); points given back are told here.
 */
export const announcePurgeableQa = (
  qa: PurgeableQa,
  notify: (text: string) => void,
  t: TFunction,
) => {
  if (qa?.revoked) {
    notify(t('qa_toast_revoked', { points: formatPoints(qa.revoked) }));
  }
  if (qa?.awarded) {
    window.dispatchEvent(new Event(QA_CHECKED_EVENT));
  }
};
