/**
 * The "Alarmablauf" tab of /escalations/ (AlarmFlowTab): every open
 * notification case as a timeline - what was sent to whom, what the sender
 * sends next, when and to whom. Data: GET /v1/notification-case/timeline/
 * (backend helper/notification_timeline.py). Read only - the actions stay
 * in the staff area (/staff/?case=<id>).
 */

export const FLOW_URL = '/v1/notification-case/timeline/';

export type FlowChannel = 'mail' | 'sms' | 'messenger';

export type FlowMail = { name: string; address: string; status: string };

export type FlowDetected = { type: 'detected'; at: string };

export type FlowSent = {
  type: 'sent';
  stage: number | null;
  at: string;
  text: string;
  mails: FlowMail[];
  sms: number;
  messenger: number;
  recipients: number;
  /** The location's notifications are off: logged, not sent. */
  withheld: boolean;
  escalation: boolean;
  objektleitung: boolean;
};

export type FlowRecipient = { name: string; channels: FlowChannel[]; objektleitung: boolean };

export type FlowPlanned = {
  type: 'planned';
  stage: number;
  /** When the rule makes it due. */
  due_at: string;
  /** When it really goes out (a mute moves it) - null: muted until unmuted. */
  at: string | null;
  overdue: boolean;
  paused: boolean;
  withheld: boolean;
  objektleitung: boolean;
  escalation: boolean;
  /** false: no customer message (the last offline stage only escalates). */
  customer: boolean;
  recipients: FlowRecipient[];
};

export type FlowPoint = FlowDetected | FlowSent | FlowPlanned;

export type FlowCase = {
  id: number;
  kind: 'alarm' | 'offline';
  phase: string;
  location_id: number;
  project_id: number | null;
  location_name: string;
  location_missing: boolean;
  stage: number;
  stages: number;
  opened_at: string;
  alarm_count: number;
  device_count: number;
  muted_until: string | null;
  muted_forever: boolean;
  acknowledged_at: string | null;
  back_since: string | null;
  unreachable_since: string | null;
  escalation_id: number | null;
  next_at: string | null;
  points: FlowPoint[];
  end: { kind: 'acknowledge' | 'back_online'; stable_hours: number | null };
};

/** `total`: every open case - the answer holds at most `limit`, the soonest. */
export type FlowAnswer = { now: string; run_minutes: number; cases: FlowCase[]; total?: number; limit?: number };

/** Where "now" stands: before the first planned stage (or after the last point). */
export const nowIndex = (points: FlowPoint[]) => {
  const index = points.findIndex((point) => point.type === 'planned');
  return index < 0 ? points.length : index;
};

/** Whole minutes from `now` until `iso` - negative when it lies in the past. */
export const minutesUntil = (iso: string, now: number) =>
  Math.round((Date.parse(iso) - now) / 60000);

/** A duration in minutes as its two largest parts: {days, hours} or {hours, minutes} or {minutes}. */
export const durationParts = (minutes: number) => {
  const total = Math.max(0, Math.round(minutes));
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const rest = total % 60;
  if (days > 0) {
    return { days, hours };
  }
  if (hours > 0) {
    return { hours, minutes: rest };
  }
  return { minutes: rest };
};

/** "today" / "tomorrow" / "yesterday" / null (another day) - in the browser's time zone. */
export const relativeDay = (iso: string, now: number): 'today' | 'tomorrow' | 'yesterday' | null => {
  const day = (ms: number) => {
    const date = new Date(ms);
    return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000;
  };
  const difference = day(Date.parse(iso)) - day(now);
  if (difference === 0) {
    return 'today';
  }
  if (difference === 1) {
    return 'tomorrow';
  }
  return difference === -1 ? 'yesterday' : null;
};

/** How a mail of a sent stage ended up: "ok" / "fail" / "held" (not sent on purpose). */
export const mailOutcome = (status: string): 'ok' | 'fail' | 'held' => {
  if (status === 'sent') {
    return 'ok';
  }
  if (status === 'withheld' || status === 'dry_run' || status === 'redirected') {
    return 'held';
  }
  return 'fail';
};
