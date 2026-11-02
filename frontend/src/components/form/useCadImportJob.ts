import { useCallback, useEffect, useRef, useState } from 'react';
import type { useAuth } from '../../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../../axiosConfig';
import { getWsBaseUrl } from '../../backendUrl';

/** A DWG/DXF import job of upload_cad (progeo/helper/cad_import.py). */
export type CadImportJob = {
  job_id: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  source_name?: string;
  log: string[];
  /** upload_cad's answer for text uploads ({location_id, stored, points}). */
  result: Record<string, unknown> | null;
  error: string | null;
};

type JobMessage = Record<string, unknown>;

// While the socket is down (or refused) the job is polled over HTTP instead.
const HTTP_POLL_MS = 3000;
// The server sends at least a heartbeat every 20 s.
const WATCHDOG_MS = 45000;

const isFinished = (job: CadImportJob | null) =>
  job?.status === 'done' || job?.status === 'failed';

const parseMessage = (raw: unknown): JobMessage | null => {
  try {
    return JSON.parse(String(raw)) as JobMessage;
  } catch {
    return null;
  }
};

/**
 * Follows an import job: the websocket /ws/cad_import/<job_id>/ (snapshot,
 * then each new log line), measure_points/cad_job over HTTP while the socket
 * is down. `onFinished` gets the job once it is done or failed.
 */
const useCadImportJob = (
  auth: ReturnType<typeof useAuth>,
  onFinished: (job: CadImportJob) => void,
) => {
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<CadImportJob | null>(null);
  const [socketDown, setSocketDown] = useState(false);

  const latest = useRef({ auth, onFinished });
  useEffect(() => {
    latest.current = { auth, onFinished };
  });
  const finishedRef = useRef<string | null>(null);

  const receiveJob = useCallback((next: CadImportJob) => {
    setJob(next);
    if (isFinished(next) && finishedRef.current !== next.job_id) {
      finishedRef.current = next.job_id;
      latest.current.onFinished(next);
    }
  }, []);

  const follow = useCallback((id: string) => {
    finishedRef.current = null;
    setSocketDown(false);
    setJob({ job_id: id, status: 'queued', log: [], result: null, error: null });
    setJobId(id);
  }, []);

  const reset = useCallback(() => {
    setJobId(null);
    setJob(null);
  }, []);

  useEffect(() => {
    if (!jobId) {
      return undefined;
    }
    let disposed = false;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const ws = new WebSocket(`${getWsBaseUrl()}/ws/cad_import/${jobId}/`);
    const armWatchdog = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => ws.close(), WATCHDOG_MS);
    };

    ws.onopen = armWatchdog;
    ws.onmessage = (event) => {
      armWatchdog();
      const data = parseMessage(event.data);
      if (!data) {
        return;
      }
      if (data.type === 'cad_snapshot' || data.type === 'cad_done') {
        receiveJob(data.job as CadImportJob);
        if (data.type === 'cad_done') {
          ws.close();
        }
      } else if (data.type === 'cad_log') {
        const seq = Number(data.seq);
        setJob((current) => {
          // A line the snapshot already had comes again.
          if (!current || seq < current.log.length) {
            return current;
          }
          return {
            ...current,
            status: current.status === 'queued' ? 'running' : current.status,
            log: [...current.log, String(data.line ?? '')],
          };
        });
      }
    };
    ws.onclose = () => {
      clearTimeout(watchdog);
      if (!disposed && finishedRef.current !== jobId) {
        setSocketDown(true);
      }
    };
    return () => {
      disposed = true;
      clearTimeout(watchdog);
      ws.onclose = null;
      ws.close();
    };
  }, [jobId, receiveJob]);

  // Socket down: poll until the job is finished.
  useEffect(() => {
    if (!jobId || !socketDown) {
      return undefined;
    }
    const poll = () => {
      void axiosConfig.perform_get(
        latest.current.auth,
        `/v1/status/measure_points/cad_job/?job_id=${encodeURIComponent(jobId)}`,
        (response) => {
          const next = response?.data?.job as CadImportJob | undefined;
          if (next) {
            receiveJob(next);
          }
        },
        () => {},
      );
    };
    poll();
    const timer = setInterval(() => {
      if (finishedRef.current === jobId) {
        clearInterval(timer);
        return;
      }
      poll();
    }, HTTP_POLL_MS);
    return () => clearInterval(timer);
  }, [jobId, socketDown, receiveJob]);

  return { job, follow, reset, running: !!job && !isFinished(job) };
};

export default useCadImportJob;
