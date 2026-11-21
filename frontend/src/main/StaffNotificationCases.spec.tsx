// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ answers: {} as Record<string, unknown>, post: vi.fn() }));

vi.mock('../axiosConfig', () => ({
  default: {
    perform_get: (_auth: unknown, url: string, ok: (response: unknown) => void) =>
      ok({ data: api.answers[url.split('?')[0]] ?? {} }),
    perform_post: (_auth: unknown, url: string, body: unknown) => api.post(url, body),
  },
}));
vi.mock('../../hooks/CoreAuthProvider', () => ({ useAuth: () => ({}) }));
vi.mock('notistack', () => ({ useSnackbar: () => ({ enqueueSnackbar: vi.fn() }) }));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

const { default: StaffNotificationCases } = await import('./StaffNotificationCases');

const CASE = (id: number, notificationsDisabled: boolean | null) => ({
  id,
  kind: 'offline',
  state: 'open',
  phase: 'notified',
  stage: 1,
  stages: 5,
  location_id: 100 + id,
  project_id: 4700 + id,
  location_name: `Halle ${id}`,
  opened_at: '16.11.2026 09:00',
  last_contact_at: null,
  next_contact_at: null,
  muted: false,
  muted_until: null,
  unreachable_since: null,
  acknowledged_at: null,
  escalation_id: null,
  resolved_at: null,
  resolution: '',
  back_since: null,
  devices: [],
  alarm_count: 0,
  notified: [],
  notifications_disabled: notificationsDisabled,
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // DataTable asks for the colour scheme; jsdom has no matchMedia.
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  api.post.mockClear();
  api.answers = {
    '/v1/notification-case/': { cases: [CASE(1, true), CASE(2, false), CASE(3, null)] },
    '/v1/notification-case/2/': { case: { ...CASE(2, false), events: [] } },
    '/v1/notification-case/summary/': {
      counts: { offline: { open: 3 }, alarm: {} },
      resolved_last_day: {},
      in_window: true,
      baseline_done: true,
      unsubscribed_last_week: 0,
      no_recipients_left: 0,
      locations: { disabled: 1, enabled: 1 },
      withheld_last_day: 0,
    },
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const rowOf = (projectId: number) =>
  [...container.querySelectorAll('.rdt_TableRow')].find((row) => row.textContent?.includes(String(projectId)))!;

describe('StaffNotificationCases', () => {
  it('stripes the cases of locations whose notifications are switched off', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <StaffNotificationCases />
        </MemoryRouter>,
      );
    });

    expect(rowOf(4701).className).toContain('location-row-off');
    expect(rowOf(4702).className).not.toContain('location-row-off');
    // Unknown location (null): not marked either.
    expect(rowOf(4703).className).not.toContain('location-row-off');
    const icons = [...container.querySelectorAll('[data-testid="location-flag-icons"]')];
    expect(icons.map((icon) => icon.getAttribute('data-test-key'))).toEqual(['case-1']);
    expect(container.querySelector('[data-testid="staff-notifications-legend"]')).not.toBeNull();
  });

  it('turns the phase summary on its side on phones', async () => {
    const desktop = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      ...desktop(query),
      matches: query.includes('max-width'),
    })) as typeof window.matchMedia;
    try {
      await act(async () => {
        root.render(
          <MemoryRouter>
            <StaffNotificationCases />
          </MemoryRouter>,
        );
      });
      const summary = container.querySelector('[data-testid="staff-notifications-summary"]')!;
      // Offline / alarm as the two columns, a phase per row (+ resolved).
      expect(summary.querySelectorAll('thead th')).toHaveLength(3);
      const firstRow = summary.querySelector('tbody tr')!;
      expect(firstRow.textContent).toContain('staff_notifications_phase_open');
      expect([...firstRow.querySelectorAll('td')].map((cell) => cell.textContent)).toEqual(['3', '0']);
    } finally {
      window.matchMedia = desktop;
    }
  });

  it('closes a case only after its confirmation', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <StaffNotificationCases />
        </MemoryRouter>,
      );
    });
    // The case's modal (a portal in <body>).
    // DataTable reacts to clicks on its cells (data-tag="allowRowEvents").
    const cell = [...rowOf(4702).querySelectorAll<HTMLElement>('[data-tag="allowRowEvents"]')].pop()!;
    await act(async () => cell.click());
    const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    await act(async () => byTestId('staff-notifications-close')!.click());

    const dialog = byTestId('staff-notifications-close-dialog');
    expect(dialog?.textContent).toContain('staff_notifications_close_confirm');
    expect(api.post).not.toHaveBeenCalled();
    await act(async () => byTestId('staff-notifications-close-dialog-cancel')!.click());
    expect(byTestId('staff-notifications-close-dialog')).toBeNull();
    expect(api.post).not.toHaveBeenCalled();

    await act(async () => byTestId('staff-notifications-close')!.click());
    await act(async () => byTestId('staff-notifications-close-dialog-confirm')!.click());
    expect(api.post).toHaveBeenCalledWith('/v1/notification-case/2/close/', {});
  });
});
