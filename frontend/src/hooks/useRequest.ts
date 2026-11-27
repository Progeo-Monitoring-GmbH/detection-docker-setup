import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import type { AuthContextType } from '../../hooks/CoreAuthProvider';
import axiosConfig from '../axiosConfig';
import { useLatestRef } from '../components/ui/useLatestRef';

/** What a failed request rejects with - the parts the pages read. */
export type RequestError = {
  response?: { status?: number; data?: unknown };
  message?: string;
};

export type RequestOptions<T> = {
  /** The session (useAuth()). Read when a request starts - its identity
   * changes with every navigation, so it never triggers a refetch. */
  auth: AuthContextType;
  /** What the page keeps of the answer's body (default: the body itself). */
  transform?: (body: any) => T;
  /** After an answer for the current URL was stored (e.g. to seed a form). */
  onSuccess?: (data: T) => void;
  /** A failed request for the current URL (e.g. the error snackbar).
   * axiosConfig's central handling (403 toast, 401 -> login) runs anyway. */
  onError?: (error: RequestError) => void;
  /** Change it to read the same URL again, loading shown - e.g. when
   * another panel changed the data. */
  revision?: unknown;
};

export type RequestState<T> = {
  /** The last answer. Kept while another URL loads (pages keep showing it
   * behind their spinner) and after an error; null before the first answer
   * and while the URL is null. */
  data: T | null;
  /** From the render the URL changes (or reload() is called) until its answer. */
  loading: boolean;
  /** The failure of the last request, until a new URL or a successful answer. */
  error: RequestError | null;
  /** Reads the URL again (refresh buttons, after saves) - or a variant of it
   * (e.g. "?refresh=true") whose answer counts for the current URL. Resolves
   * with the stored data, undefined after an error or a newer request. */
  reload: (variantUrl?: string) => Promise<T | undefined>;
  /** Changes the data locally (optimistic updates, a POST that answers with it). */
  setData: Dispatch<SetStateAction<T | null>>;
};

/**
 * GET `url` with axiosConfig.perform_get - again whenever the URL changes
 * (null: nothing to fetch). Only the answer of the newest request is applied:
 * a late answer for a previous URL never overwrites the current one. The
 * callbacks are read through a ref, so new lambdas each render don't refetch.
 */
export const useRequest = <T>(
  url: string | null,
  options: RequestOptions<T>,
): RequestState<T> => {
  const latest = useLatestRef(options);
  const { revision } = options;
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(url !== null);
  const [error, setError] = useState<RequestError | null>(null);

  // A new URL (or revision): loading from this render on - adjusted during
  // render (previous key in state), so the effect below sets no state itself.
  const [requested, setRequested] = useState({ url, revision });
  if (requested.url !== url || !Object.is(requested.revision, revision)) {
    setRequested({ url, revision });
    setLoading(url !== null);
    setError(null);
    if (url === null) {
      setData(null);
    }
  }

  // Id of the newest request; an answer carrying an older one is stale.
  const newest = useRef(0);

  // State is only set in the request callbacks (the effect may call it).
  const start = useCallback(
    (target: string) =>
      new Promise<T | undefined>((resolve) => {
        const id = ++newest.current;
        void axiosConfig.perform_get(
          latest.current.auth,
          target,
          (response) => {
            if (id !== newest.current) {
              resolve(undefined);
              return;
            }
            const { transform, onSuccess } = latest.current;
            const next = transform
              ? transform(response?.data)
              : (response?.data as T);
            setData(next);
            setError(null);
            setLoading(false);
            onSuccess?.(next);
            resolve(next);
          },
          (failure: RequestError) => {
            if (id !== newest.current) {
              resolve(undefined);
              return;
            }
            setError(failure);
            setLoading(false);
            latest.current.onError?.(failure);
            resolve(undefined);
          },
        );
      }),
    [latest],
  );

  useEffect(() => {
    if (url === null) {
      return undefined;
    }
    void start(url);
    // Leaving this URL (or unmounting): its answer is stale.
    return () => {
      newest.current += 1;
    };
  }, [url, revision, start]);

  const reload = useCallback(
    (variantUrl?: string) => {
      if (url === null) {
        return Promise.resolve(undefined);
      }
      setLoading(true);
      return start(variantUrl ?? url);
    },
    [start, url],
  );

  return { data, loading, error, reload, setData };
};
