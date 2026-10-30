import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../../../hooks/CoreAuthProvider';
import axiosConfig from '../../axiosConfig';

/**
 * The Lageplan image at `url`, loaded once per url with the Authorization
 * header (media is authenticated) and decoded for drawing. Null without url,
 * while loading and when it fails - the heatmap is then shown without it.
 */
export const useLageplanImage = (url: string | null) => {
  const auth = useAuth();
  const authRef = useRef(auth);
  useEffect(() => {
    authRef.current = auth;
  }, [auth]);
  const [loaded, setLoaded] = useState<{ url: string; image: HTMLImageElement } | null>(null);

  useEffect(() => {
    if (!url) {
      return undefined;
    }
    let cancelled = false;
    void axiosConfig.perform_get(
      authRef.current,
      url,
      (response) => {
        const reader = new FileReader();
        reader.onload = () => {
          if (cancelled || typeof reader.result !== 'string') {
            return;
          }
          const image = new Image();
          image.onload = () => {
            if (!cancelled) {
              setLoaded({ url, image });
            }
          };
          image.src = reader.result;
        };
        reader.readAsDataURL(response.data as Blob);
      },
      () => {
        // No plan image - the heatmap is still shown without it.
      },
      { responseType: 'blob' },
    );
    return () => {
      cancelled = true;
    };
  }, [url]);

  return loaded?.url === url ? loaded.image : null;
};
