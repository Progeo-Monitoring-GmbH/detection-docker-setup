import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../../../hooks/CoreAuthProvider';
import axiosConfig from '../../axiosConfig';

type Auth = ReturnType<typeof useAuth>;

/**
 * Decoded plan images, newest last - per user (media is authenticated), so a
 * plan switch back (or one preloaded) draws at once instead of first without
 * its image. Kept small: plans can be large images.
 */
const MAX_CACHED_IMAGES = 12;
const decoded = new Map<string, HTMLImageElement>();
const loading = new Map<string, Promise<HTMLImageElement | null>>();

const cacheKey = (auth: Auth, url: string) => `${(auth?.user as { id?: number } | null)?.id ?? 0}@${url}`;

const remember = (key: string, image: HTMLImageElement) => {
  decoded.delete(key);
  decoded.set(key, image);
  while (decoded.size > MAX_CACHED_IMAGES) {
    decoded.delete(decoded.keys().next().value as string);
  }
};

/** The image at `url` (with the Authorization header), decoded; null when it
 * can't be loaded. Requests for the same image are shared. */
const loadLageplanImage = (auth: Auth, url: string): Promise<HTMLImageElement | null> => {
  const key = cacheKey(auth, url);
  const cached = decoded.get(key);
  if (cached) {
    return Promise.resolve(cached);
  }
  const pending = loading.get(key);
  if (pending) {
    return pending;
  }
  const request = new Promise<HTMLImageElement | null>((resolve) => {
    void axiosConfig.perform_get(
      auth,
      url,
      (response) => {
        const reader = new FileReader();
        reader.onload = () => {
          if (typeof reader.result !== 'string') {
            resolve(null);
            return;
          }
          const image = new Image();
          image.onload = () => {
            remember(key, image);
            resolve(image);
          };
          image.onerror = () => resolve(null);
          image.src = reader.result;
        };
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(response.data as Blob);
      },
      () => resolve(null),
      { responseType: 'blob' },
    );
  }).finally(() => loading.delete(key));
  loading.set(key, request);
  return request;
};

/**
 * The Lageplan image at `url` (loaded with the Authorization header - media
 * is authenticated - and decoded for drawing) and whether it is still
 * loading. A cached image is there at once; `pending` is false without url
 * and once loading ended - also when it failed (image null, the heatmap is
 * then shown without it).
 */
export const useLageplanImageState = (url: string | null) => {
  const auth = useAuth();
  const authRef = useRef(auth);
  useEffect(() => {
    authRef.current = auth;
  }, [auth]);
  const [settled, setSettled] = useState<{ url: string; image: HTMLImageElement | null } | null>(null);
  const cached = url ? (decoded.get(cacheKey(auth, url)) ?? null) : null;

  useEffect(() => {
    if (!url || cached) {
      return undefined;
    }
    let cancelled = false;
    void loadLageplanImage(authRef.current, url).then((image) => {
      if (!cancelled) {
        setSettled({ url, image });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [url, cached]);

  if (!url) {
    return { image: null, pending: false };
  }
  if (cached) {
    return { image: cached, pending: false };
  }
  return settled?.url === url ? { image: settled.image, pending: false } : { image: null, pending: true };
};

/** Loads the images at `urls` in the background (e.g. every plan of a
 * location), so switching to another plan shows it at once. */
export const usePreloadLageplanImages = (urls: string[]) => {
  const auth = useAuth();
  const authRef = useRef(auth);
  useEffect(() => {
    authRef.current = auth;
  }, [auth]);
  const key = urls.join('\n');
  useEffect(() => {
    if (!key) {
      return;
    }
    key.split('\n').forEach((url) => void loadLageplanImage(authRef.current, url));
  }, [key]);
};
