// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
  gets: 0,
  favorites: [] as { location: number }[],
  auth: { token: '', user: null as Record<string, unknown> | null },
}));

vi.mock('../axiosConfig', () => ({
  default: {
    perform_get: (_auth: unknown, _url: string, ok: (response: unknown) => void) => {
      state.gets += 1;
      ok({ data: { favorites: state.favorites, max: 10 } });
      return Promise.resolve();
    },
    perform_post: () => Promise.resolve(),
  },
}));
vi.mock('../../hooks/CoreAuthProvider', () => ({ useAuth: () => state.auth }));
vi.mock('notistack', () => ({ useSnackbar: () => ({ enqueueSnackbar: () => undefined }) }));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

const { useFavorites } = await import('./favorites');

/** An unsigned JWT - `jti` tells the tokens of one user apart. */
const jwt = (userId: number, jti: string) => {
  const part = (value: object) => btoa(JSON.stringify(value)).replace(/=+$/, '');
  return `${part({ alg: 'none' })}.${part({ user_id: userId, jti })}.sig`;
};

let container: HTMLDivElement;
let root: Root;
let shown: number[] = [];
const history: number[][] = [];

const Probe = () => {
  const { favorites } = useFavorites();
  shown = favorites.map((row) => row.location);
  history.push(shown);
  return null;
};

const render = async (token: string, userId: number | null) => {
  state.auth = { token, user: userId == null ? null : { user_id: userId } };
  await act(async () => {
    root.render(<Probe />);
  });
};

beforeEach(() => {
  state.gets = 0;
  history.length = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('useFavorites', () => {
  it('keeps the favorites when the token of the same user is renewed', async () => {
    state.favorites = [{ location: 1 }, { location: 2 }];
    await render(jwt(41, 'a'), 41);
    expect(shown).toEqual([1, 2]);
    const loaded = history.length;

    await render(jwt(41, 'b'), 41);

    expect(state.gets).toBe(1);
    // Never emptied in between (the bar would flicker).
    expect(history.slice(loaded).every((row) => row.length === 2)).toBe(true);
  });

  it('loads them again for another user', async () => {
    state.favorites = [{ location: 1 }];
    await render(jwt(42, 'a'), 42);
    state.favorites = [{ location: 3 }];

    await render(jwt(43, 'a'), 43);

    expect(state.gets).toBe(2);
    expect(shown).toEqual([3]);
  });

  it('loads them again after a logout and a new login of the same user', async () => {
    state.favorites = [{ location: 1 }];
    await render(jwt(44, 'a'), 44);
    await render('', null);
    expect(shown).toEqual([]);
    state.favorites = [{ location: 5 }];

    await render(jwt(44, 'b'), 44);

    expect(state.gets).toBe(2);
    expect(shown).toEqual([5]);
  });
});
