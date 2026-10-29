import { useCallback, useEffect, useRef, useState } from 'react';
import type { useAuth } from '../../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../../axiosConfig';
import { getWsBaseUrl } from '../../backendUrl';

/** One file of the file list (log_files_helper.summarize_log_files). */
export type LogFileItem = {
  file: string;
  path: string;
  size_bytes: number;
  modified_at: string;
};

export type LogStreamStatus = 'connecting' | 'live' | 'reconnecting' | 'denied';

const WS_PATH = '/ws/logs/stream/';
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 15000;
// The server sends at least a heartbeat every 20 s - silence beyond this
// means a dead connection the browser hasn't noticed (sleep, proxy).
const WATCHDOG_MS = 45000;
// While the socket is down the selected file is read over HTTP instead.
const HTTP_POLL_MS = 5000;
// Appended lines kept in the viewer beyond the requested tail.
const MAX_BUFFER_LINES = 5000;

const keepLastLines = (text: string, count: number) => {
  let index = text.length;
  for (let found = 0; found <= count; found += 1) {
    index = text.lastIndexOf('\n', index - 1);
    if (index < 0) {
      return text;
    }
  }
  return text.slice(index + 1);
};

/**
 * The Admin Panel's live log (progeo.consumer.LogStreamConsumer): own
 * websocket, reconnected with backoff for as long as the panel is open; the
 * selected file is streamed again after every reconnect, and read over HTTP
 * while the socket is down. Messages are handled as they arrive (no state
 * hand-over that could swallow one), appends are added to the content.
 */
const useLogStream = (auth: ReturnType<typeof useAuth>, lines: number) => {
  const [status, setStatus] = useState<LogStreamStatus>('connecting');
  const [files, setFiles] = useState<LogFileItem[] | null>(null);
  const [selected, setSelected] = useState('');
  const [content, setContent] = useState<string | null>(null);
  const [meta, setMeta] = useState<LogFileItem | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const selectedRef = useRef('');
  const linesRef = useRef(lines);
  linesRef.current = lines;
  const authRef = useRef(auth);
  authRef.current = auth;

  const send = useCallback((payload: object) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
      return true;
    }
    return false;
  }, []);

  const loadOverHttp = useCallback((file: string) => {
    void axiosConfig.perform_get(
      authRef.current,
      `/v1/status/admin/log_files/?file=${encodeURIComponent(file)}&lines=${linesRef.current}`,
      (response) => {
        const data = response?.data || {};
        if (file !== selectedRef.current) {
          return;
        }
        setContent(data.content || '');
        setMeta(data as LogFileItem);
        setUpdatedAt(new Date());
      },
      (requestError) => {
        setError(String(requestError?.response?.data?.reason || requestError?.message || requestError));
      },
    );
  }, []);

  const listOverHttp = useCallback(() => {
    void axiosConfig.perform_get(
      authRef.current,
      '/v1/status/admin/log_files/',
      (response) => setFiles((response?.data?.files || []) as LogFileItem[]),
      () => setFiles((current) => current ?? []),
    );
  }, []);

  const select = useCallback(
    (file: string) => {
      selectedRef.current = file;
      setSelected(file);
      setContent(null);
      setError(null);
      if (!send({ action: 'stream_file', file, lines: linesRef.current })) {
        loadOverHttp(file);
      }
    },
    [loadOverHttp, send],
  );

  const refreshFiles = useCallback(() => {
    if (!send({ action: 'list_files' })) {
      listOverHttp();
    }
  }, [listOverHttp, send]);

  // A new tail length: stream the file again with it.
  useEffect(() => {
    if (selectedRef.current) {
      select(selectedRef.current);
    }
  }, [lines, select]);

  useEffect(() => {
    let disposed = false;
    let attempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;

    const armWatchdog = (ws: WebSocket) => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => ws.close(), WATCHDOG_MS);
    };

    const connect = () => {
      if (disposed) {
        return;
      }
      const ws = new WebSocket(getWsBaseUrl().concat(WS_PATH));
      wsRef.current = ws;

      ws.onopen = () => {
        attempt = 0;
        setStatus('live');
        setError(null);
        armWatchdog(ws);
        ws.send(JSON.stringify({ action: 'list_files' }));
        if (selectedRef.current) {
          ws.send(
            JSON.stringify({ action: 'stream_file', file: selectedRef.current, lines: linesRef.current }),
          );
        }
      };

      ws.onmessage = (event) => {
        armWatchdog(ws);
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(event.data);
        } catch {
          return;
        }
        const type = data.type;
        if (type === 'file_list') {
          const list = (data.files || []) as LogFileItem[];
          setFiles(list);
          if (!selectedRef.current && list.length > 0) {
            selectedRef.current = list[0].file;
            setSelected(list[0].file);
            ws.send(JSON.stringify({ action: 'stream_file', file: list[0].file, lines: linesRef.current }));
          }
        } else if (type === 'log_content' || type === 'log_append') {
          if (data.file !== selectedRef.current) {
            return; // a file switched away from
          }
          const text = String(data.content ?? '');
          if (type === 'log_content') {
            setContent(text);
          } else {
            setContent((current) => keepLastLines((current ?? '') + text, MAX_BUFFER_LINES));
          }
          setMeta((current) => ({
            file: String(data.file),
            path: String(data.path ?? current?.path ?? ''),
            size_bytes: Number(data.size_bytes ?? 0),
            modified_at: String(data.modified_at ?? ''),
          }));
          setUpdatedAt(new Date());
          setError(null);
        } else if (type === 'error') {
          setError(String(data.message ?? 'Error'));
        }
      };

      ws.onclose = (event) => {
        clearTimeout(watchdog);
        if (disposed) {
          return;
        }
        if (event.code === 4403) {
          setStatus('denied');
          return;
        }
        setStatus('reconnecting');
        const delay = Math.min(RECONNECT_MIN_MS * 2 ** attempt, RECONNECT_MAX_MS);
        attempt += 1;
        reconnectTimer = setTimeout(connect, delay);
      };
    };

    // Back online / tab visible again: don't wait for the backoff.
    const reconnectNow = () => {
      const ws = wsRef.current;
      if (!disposed && (!ws || ws.readyState === WebSocket.CLOSED)) {
        clearTimeout(reconnectTimer);
        attempt = 0;
        connect();
      }
    };

    connect();
    window.addEventListener('online', reconnectNow);
    document.addEventListener('visibilitychange', reconnectNow);
    return () => {
      disposed = true;
      clearTimeout(reconnectTimer);
      clearTimeout(watchdog);
      window.removeEventListener('online', reconnectNow);
      document.removeEventListener('visibilitychange', reconnectNow);
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
    };
  }, []);

  // Socket down (or never up): the file list and the selected file over HTTP.
  const socketDown = status === 'reconnecting' || status === 'denied';
  useEffect(() => {
    if (!socketDown) {
      return undefined;
    }
    if (files === null) {
      listOverHttp();
    }
    if (!selected) {
      return undefined;
    }
    loadOverHttp(selected);
    const timer = setInterval(() => loadOverHttp(selected), HTTP_POLL_MS);
    return () => clearInterval(timer);
  }, [socketDown, selected, files, listOverHttp, loadOverHttp]);

  // Without a socket the first file is picked from the HTTP list.
  useEffect(() => {
    if (socketDown && !selectedRef.current && files && files.length > 0) {
      select(files[0].file);
    }
  }, [socketDown, files, select]);

  return { status, files, selected, select, refreshFiles, content, meta, updatedAt, error };
};

export default useLogStream;
