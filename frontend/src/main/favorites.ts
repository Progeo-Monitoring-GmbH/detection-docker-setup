import { useEffect, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { useSnackbar } from 'notistack';
import { useAuth } from '../../hooks/CoreAuthProvider';
import axiosConfig from '../axiosConfig';
import { showErrorBar, showRequestError } from '../components/ui/Snackbar.jsx';

/**
 * Favorite locations of a staff user (/v1/favorite/, FavoriteViewSet) - the
 * favorites bar at the top and every star toggle share this one store, so
 * pinning a location anywhere shows up everywhere at once. Loaded once per
 * login (token).
 */

export type FavoriteLocation = {
  location: number;
  name: string | null;
  project_id: number | null;
  city: string | null;
};

type FavoritesState = {
  /** The login the favorites belong to. */
  token: string | null;
  favorites: FavoriteLocation[];
  max: number;
  /** Locations whose toggle is on its way. */
  pending: number[];
};

const FAVORITES_URL = '/v1/favorite/';

let state: FavoritesState = { token: null, favorites: [], max: 10, pending: [] };
const listeners = new Set<() => void>();

const setState = (change: Partial<FavoritesState>) => {
  state = { ...state, ...change };
  listeners.forEach((listener) => listener());
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const getState = () => state;

type FavoritesResponse = { data?: { favorites?: FavoriteLocation[]; max?: number } };

const adopt = (response: FavoritesResponse) =>
  setState({ favorites: response?.data?.favorites ?? [], max: response?.data?.max ?? state.max });

/** Whether the user is staff - only staff have favorites. */
export const isStaffUser = (user: unknown) => {
  const flags = user as { is_staff?: boolean; is_superuser?: boolean } | null;
  return Boolean(flags?.is_staff || flags?.is_superuser);
};

export const useFavorites = () => {
  const { t } = useTranslation();
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const enabled = isStaffUser(auth?.user);
  const token = auth?.token || null;
  const current = useSyncExternalStore(subscribe, getState);

  useEffect(() => {
    if (!enabled || !token || state.token === token) {
      return;
    }
    setState({ token, favorites: [], pending: [] });
    void axiosConfig.perform_get(auth, FAVORITES_URL, adopt, () => setState({ favorites: [] }));
    // Once per login - `auth` changes with the path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, token]);

  const favorites = enabled && current.token === token ? current.favorites : [];
  const isFavorite = (locationId: number) => favorites.some((row) => row.location === locationId);

  const toggle = (locationId: number) => {
    if (!enabled || state.pending.includes(locationId)) {
      return;
    }
    const favorite = !isFavorite(locationId);
    if (favorite && favorites.length >= current.max) {
      showErrorBar(enqueueSnackbar, t('favorites_full', { max: current.max }));
      return;
    }
    setState({ pending: [...state.pending, locationId] });
    const done = () => setState({ pending: state.pending.filter((id) => id !== locationId) });
    void axiosConfig.perform_post(
      auth,
      FAVORITES_URL,
      { location: locationId, favorite },
      (response) => {
        adopt(response);
        done();
      },
      (error) => {
        done();
        showRequestError(enqueueSnackbar, t('favorites_failed'), error);
      },
    );
  };

  return {
    enabled,
    favorites,
    max: current.max,
    isFavorite,
    isPending: (locationId: number) => current.pending.includes(locationId),
    toggle,
  };
};
