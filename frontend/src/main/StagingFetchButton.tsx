import { useEffect, useRef, useState } from 'react';
import { Spinner } from 'react-bootstrap';
import { CloudDownload } from 'react-bootstrap-icons';
import { useTranslation } from 'react-i18next';
import { useSnackbar } from 'notistack';
import { useAuth } from '../../hooks/CoreAuthProvider';
import axiosConfig from '../axiosConfig';
import {
  showErrorBar,
  showRequestError,
  showSuccessBar,
} from '../components/ui/Snackbar.jsx';
import PillButton from '../components/ui/kit/PillButton';
import { SCREEN_REVIEW_URL } from './screenReview';
import { useLatestRef } from '../components/ui/useLatestRef';

/** GET/POST /v1/screen-review/fetch/ (backend helper/screen_review_fetch.py). */
type FetchState = {
  status: 'idle' | 'queued' | 'running' | 'done' | 'failed';
  runs?: string[];
  files?: number;
  skipped?: number;
  error?: string;
  at?: string;
};

const POLL_MS = 3000;

const isFetching = (state: FetchState | null) =>
  state?.status === 'queued' || state?.status === 'running';

/**
 * "Fetch from staging" of the screen review - only on a server without the
 * screenshot container (no COMPOSE_PROFILES=e2e_screens, i.e. live): the
 * backend downloads the staging server's runs it lacks over SSH, in the
 * background; this asks every few seconds until it is done and then has the
 * runs reloaded (`onFetched`).
 */
const StagingFetchButton = ({ onFetched }: { onFetched: () => void }) => {
  const auth = useAuth();
  const { t } = useTranslation();
  const { enqueueSnackbar } = useSnackbar();
  const [enabled, setEnabled] = useState(false);
  const [state, setState] = useState<FetchState | null>(null);
  // Only a fetch started (or seen running) here reports its end.
  const watching = useRef(false);
  const onFetchedRef = useLatestRef(onFetched);

  const url = `${SCREEN_REVIEW_URL}fetch/`;
  const fetching = isFetching(state);

  // A new state - the end of a watched fetch is reported once.
  const settle = (next: FetchState | null) => {
    setState(next);
    if (!watching.current || isFetching(next)) {
      return;
    }
    watching.current = false;
    if (next?.status === 'failed') {
      showErrorBar(
        enqueueSnackbar,
        t('screens_fetch_failed', { error: next.error ?? '' }),
      );
    } else {
      showSuccessBar(
        enqueueSnackbar,
        t('screens_fetch_done', { count: next?.runs?.length ?? 0 }),
      );
      onFetchedRef.current();
    }
  };
  const settleRef = useLatestRef(settle);

  useEffect(() => {
    void axiosConfig.perform_get(auth, url, (response) => {
      setEnabled(Boolean(response?.data?.enabled));
      const current = (response?.data?.state ?? null) as FetchState | null;
      setState(current);
      watching.current = isFetching(current);
    });
    // Once - `auth` changes with the path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // While it runs: ask again, and report the end once.
  useEffect(() => {
    if (!fetching) {
      return undefined;
    }
    const timer = window.setTimeout(() => {
      void axiosConfig.perform_get(auth, url, (response) =>
        settleRef.current((response?.data?.state ?? null) as FetchState | null),
      );
    }, POLL_MS);
    return () => window.clearTimeout(timer);
  }, [auth, fetching, state, url, settleRef]);

  if (!enabled) {
    return null;
  }

  const start = () => {
    watching.current = true;
    setState({ status: 'queued' });
    void axiosConfig.perform_post(
      auth,
      url,
      {},
      // Without a task queue (local development) it is already done here.
      (response) =>
        settle((response?.data?.state ?? { status: 'queued' }) as FetchState),
      (error) => {
        watching.current = false;
        setState({ status: 'idle' });
        showRequestError(
          enqueueSnackbar,
          t('screens_fetch_failed', { error: '' }),
          error,
        );
      },
    );
  };

  return (
    <PillButton
      label={
        fetching
          ? t('screens_fetch_running', { count: state?.runs?.length ?? 0 })
          : t('screens_fetch')
      }
      title={t('screens_fetch_hint')}
      icon={
        fetching ? <Spinner animation="border" size="sm" /> : <CloudDownload />
      }
      onClick={start}
      disabled={fetching}
      testId="screens-fetch"
    />
  );
};

export default StagingFetchButton;
