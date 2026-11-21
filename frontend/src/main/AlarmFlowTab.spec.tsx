// @vitest-environment jsdom
// The "Alarmablauf" tab of /escalations/: every open case as a timeline -
// what was sent (with the mail status per recipient), "jetzt", what comes
// next with its countdown, how it ends; the link into the staff area.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowAnswer, FlowCase } from './alarmFlow';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ answer: null as unknown, urls: [] as string[] }));

vi.mock('../axiosConfig', () => ({
  default: {
    perform_get: (_auth: unknown, url: string, ok: (response: unknown) => void) => {
      api.urls.push(url);
      ok({ data: api.answer });
    },
  },
}));
vi.mock('../../hooks/CoreAuthProvider', () => ({ useAuth: () => ({}) }));
vi.mock('notistack', () => ({ useSnackbar: () => ({ enqueueSnackbar: vi.fn() }) }));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTranslation: () => ({
    // The key with its values - enough to see what was asked for.
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key}(${Object.entries(values).map(([name, value]) => `${name}=${value}`).join(',')})` : key,
  }),
}));

const { default: AlarmFlowTab } = await import('./AlarmFlowTab');

// "jetzt" 16:25 local time; the reminder at 18:05 - in 1 h 40 min.
const NOW = new Date(2026, 10, 21, 16, 25);
const local = (hour: number, minute = 0, day = 21) => new Date(2026, 10, day, hour, minute).toISOString();

const ALARM: FlowCase = {
  id: 7,
  kind: 'alarm',
  phase: 'notified',
  location_id: 11,
  project_id: 4711,
  location_name: 'Halle Nord',
  location_missing: false,
  stage: 1,
  stages: 3,
  opened_at: local(14, 2),
  alarm_count: 3,
  device_count: 0,
  muted_until: null,
  muted_forever: false,
  acknowledged_at: null,
  back_since: null,
  unreachable_since: null,
  escalation_id: null,
  next_at: local(18, 5),
  points: [
    { type: 'detected', at: local(14, 2) },
    {
      type: 'sent', stage: 1, at: local(14, 5), text: 'Stufe 1 versendet', sms: 1, messenger: 1, recipients: 3,
      withheld: false, escalation: false, objektleitung: false,
      mails: [
        { name: 'M. Müller', address: 'mueller@progeo.com', status: 'sent' },
        { name: 'J. Weber', address: 'weber@progeo.com', status: 'bounced' },
      ],
    },
    {
      type: 'planned', stage: 2, due_at: local(18, 5), at: local(18, 5), overdue: false, paused: false,
      withheld: false, objektleitung: false, escalation: false, customer: true,
      recipients: [{ name: 'M. Müller', channels: ['mail', 'sms'], objektleitung: false }],
    },
    {
      type: 'planned', stage: 3, due_at: local(14, 5, 22), at: local(14, 5, 22), overdue: false, paused: false,
      withheld: false, objektleitung: true, escalation: true, customer: true,
      recipients: [
        { name: 'M. Müller', channels: ['mail', 'sms'], objektleitung: false },
        { name: 'H. Schulz', channels: ['mail'], objektleitung: true },
      ],
    },
  ],
  end: { kind: 'acknowledge', stable_hours: null },
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(NOW);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  api.urls = [];
  api.answer = { now: NOW.toISOString(), run_minutes: 15, cases: [ALARM] } satisfies FlowAnswer;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

const render = () =>
  act(() => {
    root.render(
      <MemoryRouter>
        <AlarmFlowTab />
      </MemoryRouter>,
    );
  });
const byTestId = (id: string, key?: string | number) =>
  container.querySelector<HTMLElement>(`[data-testid="${id}"]${key != null ? `[data-test-key="${key}"]` : ''}`);

describe('AlarmFlowTab', () => {
  it('shows what was sent, "jetzt" and what comes next, in that order', () => {
    render();

    expect(api.urls).toEqual(['/v1/notification-case/timeline/']);
    const points = [...container.querySelectorAll('[data-testid="alarm-flow-point"]')].map(
      (node) => node.getAttribute('data-test-key'),
    );
    expect(points).toEqual(['7-0', '7-1', '7-2', '7-3']);
    // "jetzt" sits between the sent stage and the first planned one.
    const rail = byTestId('alarm-flow-now', 7)!.parentElement!;
    const order = [...rail.children].map((child) => child.getAttribute('data-test-key') ?? child.className);
    expect(order.indexOf('7')).toBe(2);
  });

  it('lists the mails of a sent stage with their status', () => {
    render();

    const sent = byTestId('alarm-flow-point', '7-1')!.textContent!;
    expect(sent).toContain('flow_sent(stage=1)');
    expect(sent).toContain('M. Müller');
    expect(sent).toContain('flow_mail_sent');
    expect(sent).toContain('J. Weber');
    expect(sent).toContain('flow_mail_bounced');
    expect(sent).toContain('flow_failed_count(count=1)');
  });

  it('counts down to the next stage and names its recipients', () => {
    render();

    const reminder = byTestId('alarm-flow-point', '7-2')!.textContent!;
    expect(reminder).toContain('flow_in(duration=flow_duration_hm(hours=1,minutes=40))');
    expect(reminder).toContain('flow_planned_reminder');
    expect(byTestId('alarm-flow-next', 7)!.textContent).toContain('flow_day_today');

    const last = byTestId('alarm-flow-point', '7-3')!.textContent!;
    expect(last).toContain('flow_day_tomorrow');
    expect(last).toContain('flow_objektleitung');
    expect(last).toContain('H. Schulz');
    expect(last).toContain('flow_escalation');
  });

  it('links the case into the staff area and the object to its status page', () => {
    render();

    expect(byTestId('alarm-flow-staff-link', 7)!.getAttribute('href')).toBe('/staff/?case=7');
    expect(container.querySelector('a.alarm-flow-title')!.getAttribute('href')).toBe('/location/11/status');
  });

  it('shows a mute until unmuted instead of a countdown', () => {
    const planned = ALARM.points[2];
    api.answer = {
      now: NOW.toISOString(), run_minutes: 15,
      cases: [{ ...ALARM, next_at: null, muted_forever: true, points: [ALARM.points[0], ALARM.points[1],
        { ...planned, at: null, paused: true } as FlowCase['points'][number]] }],
    };
    render();

    expect(byTestId('alarm-flow-point', '7-2')!.textContent).toContain('flow_muted_forever');
    expect(byTestId('alarm-flow-next', 7)!.textContent).toBe('flow_next_none');
  });

  it('says how many open cases it leaves out', () => {
    api.answer = { now: NOW.toISOString(), run_minutes: 15, cases: [ALARM], total: 978, limit: 200 };
    render();

    expect(byTestId('alarm-flow-truncated')!.textContent).toBe('flow_truncated(shown=1,total=978)');
  });

  it('says nothing about a limit when every case is shown', () => {
    api.answer = { now: NOW.toISOString(), run_minutes: 15, cases: [ALARM], total: 1, limit: 200 };
    render();

    expect(byTestId('alarm-flow-truncated')).toBeNull();
  });

  it('says so when no case is open', () => {
    api.answer = { now: NOW.toISOString(), run_minutes: 15, cases: [] };
    render();

    expect(byTestId('alarm-flow-empty')!.textContent).toBe('flow_empty');
  });

  it('reloads every minute', () => {
    render();
    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(api.urls).toHaveLength(2);
  });
});
