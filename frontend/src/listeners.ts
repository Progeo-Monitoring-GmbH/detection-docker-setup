/**
 * The listeners of a module-level store (favorites, location flags,
 * maintenance, token refresh, ...): `subscribe` returns the unsubscribe -
 * the shape React's useSyncExternalStore expects - and `notify` calls every
 * listener with the given arguments.
 */
export const createListeners = <Args extends unknown[] = []>() => {
  const listeners = new Set<(...args: Args) => void>();
  return {
    subscribe: (listener: (...args: Args) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    notify: (...args: Args) => {
      listeners.forEach((listener) => listener(...args));
    },
  };
};
