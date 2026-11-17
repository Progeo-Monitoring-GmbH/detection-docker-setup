// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  post: vi.fn(),
  // Answers by URL; an Error is the request's failure.
  answers: {} as Record<string, unknown>,
}));

vi.mock('../axiosConfig', () => ({
  default: {
    perform_post: (
      _auth: unknown,
      url: string,
      body: unknown,
      ok: (response: unknown) => void,
      failed: (error: unknown) => void,
    ) => {
      api.post(url, body);
      const answer = api.answers[url];
      if (answer instanceof Error) {
        failed(answer);
      } else {
        ok({ data: answer });
      }
    },
  },
}));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'de', changeLanguage: () => Promise.resolve() } }),
}));

const { default: NotificationLinkPage } = await import('./NotificationLinkPage');

const INFO = {
  kind: 'alarm',
  project_nr: 4711,
  project_name: 'Halle Nord',
  case_number: '4711-20261115',
  state: 'open',
  resolution: '',
  acknowledged: false,
  unsubscribed: false,
  address: 'rudi.radau@progeo.com',
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  api.post.mockClear();
  api.answers = { '/api/auth-support/notifications/check/': INFO };
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = (path: string) =>
  act(() => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/benachrichtigung/:token" element={<NotificationLinkPage />} />
        </Routes>
      </MemoryRouter>,
    );
  });
const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const urls = () => api.post.mock.calls.map(([url]) => url);

describe('NotificationLinkPage', () => {
  it('only reads the link on load - mail scanners must not acknowledge anything', () => {
    render('/benachrichtigung/tok123?aktion=quittieren');
    expect(urls()).toEqual(['/api/auth-support/notifications/check/']);
    expect(byTestId('notification-link-submit')!.textContent).toBe('notification_link_alarm_button');
  });

  it('acknowledges the alarm on the button', () => {
    api.answers['/api/auth-support/notifications/acknowledge/'] = { ...INFO, state: 'resolved' };
    render('/benachrichtigung/tok123?aktion=quittieren');
    act(() => byTestId('notification-link-submit')!.click());
    expect(api.post).toHaveBeenLastCalledWith('/api/auth-support/notifications/acknowledge/', { token: 'tok123' });
    expect(byTestId('notification-link-done')!.textContent).toBe('notification_link_alarm_acknowledged');
    expect(byTestId('notification-link-submit')).toBeNull();
  });

  it('unsubscribes on the button of the unsubscribe link', () => {
    api.answers['/api/auth-support/notifications/unsubscribe/'] = { ...INFO, unsubscribed: true };
    render('/benachrichtigung/tok123?aktion=abmelden');
    expect(byTestId('notification-link-submit')!.textContent).toBe('notification_link_unsubscribe_button');
    act(() => byTestId('notification-link-submit')!.click());
    expect(api.post).toHaveBeenLastCalledWith('/api/auth-support/notifications/unsubscribe/', { token: 'tok123' });
    expect(byTestId('notification-link-done')!.textContent).toBe('notification_link_unsubscribed');
  });

  it('says so when the link is invalid or expired', () => {
    api.answers['/api/auth-support/notifications/check/'] = new Error('400');
    render('/benachrichtigung/expired');
    expect(byTestId('notification-link-invalid')).not.toBeNull();
    expect(byTestId('notification-link-submit')).toBeNull();
  });
});
