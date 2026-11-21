import { useSyncExternalStore } from 'react';

/**
 * Phone width - where the pages switch to their compact layouts (tables with
 * fewer columns, KPIs two by two, the top bar as icons). The CSS uses the
 * same width in its @media rules.
 */
const PHONE_QUERY = '(max-width: 640px)';

type Store = { subscribe: (onChange: () => void) => () => void; snapshot: () => boolean };

// One store per query - stable functions, so React doesn't resubscribe on every render.
const stores = new Map<string, Store>();

const storeFor = (query: string): Store => {
  let store = stores.get(query);
  if (!store) {
    store = {
      subscribe: (onChange) => {
        if (typeof window === 'undefined' || !window.matchMedia) {
          return () => undefined;
        }
        const media = window.matchMedia(query);
        media.addEventListener('change', onChange);
        return () => media.removeEventListener('change', onChange);
      },
      snapshot: () => typeof window !== 'undefined' && Boolean(window.matchMedia?.(query).matches),
    };
    stores.set(query, store);
  }
  return store;
};

const serverSnapshot = () => false;

/** Whether the screen is phone-sized (PHONE_QUERY) - follows rotation and resizing. */
const useIsMobile = (query: string = PHONE_QUERY) => {
  const store = storeFor(query);
  return useSyncExternalStore(store.subscribe, store.snapshot, serverSnapshot);
};

export default useIsMobile;
