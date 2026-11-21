import { useEffect, useRef, useState, type DependencyList } from 'react';
import { useAuth } from '../../../hooks/CoreAuthProvider';
import axiosConfig from '../../axiosConfig';

type Latest<T> = {
  auth: ReturnType<typeof useAuth>;
  url: string;
  onData: (data: T) => boolean;
  onError: (error: unknown) => void;
};

/**
 * GETs `url` when the component mounts (again when `deps` change) and then
 * every `intervalMs` as long as `onData` returns true - something is still
 * running (an open device command, a firmware update). Stops on unmount and
 * drops answers that arrive after it. Returns `load`: a reload that restarts
 * the polling (after the user started something).
 */
const usePolledGet = <T,>(
  url: string,
  onData: (data: T) => boolean,
  onError: (error: unknown) => void,
  intervalMs: number,
  deps: DependencyList,
) => {
  const auth = useAuth();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closedRef = useRef(false);
  // The current props for the stable `load` (a timer calls it renders later).
  const latest = useRef<Latest<T>>({ auth, url, onData, onError });
  latest.current = { auth, url, onData, onError };

  const [load] = useState(() => {
    const run = () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      const current = latest.current;
      void axiosConfig.perform_get(
        current.auth,
        current.url,
        (response) => {
          if (closedRef.current) {
            return;
          }
          if (latest.current.onData(response?.data as T)) {
            timerRef.current = setTimeout(run, intervalMs);
          }
        },
        (error) => latest.current.onError(error),
      );
    };
    return run;
  });

  useEffect(() => {
    closedRef.current = false;
    load();
    return () => {
      closedRef.current = true;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return load;
};

export default usePolledGet;
