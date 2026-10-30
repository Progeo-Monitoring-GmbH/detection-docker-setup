import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { useAuth } from '../../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../../axiosConfig';
import { getWsBaseUrl } from '../../backendUrl';

/** One file of the file list (log_files_helper.summarize_log_files). */
type LogFileItem = {
  file: string;
  path: string;
  size_bytes: number;
  modified_at: string;
};

export type LogStreamStatus = 'connecting' | 'live' | 'reconnecting' | 'denied';

type LogMessage = Record<string, unknown>;

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
// Close code of the consumer for users without access.
const DENIED_CODE = 4403;

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

const parseMessage = (raw: unknown): LogMessage | null => {
  try {
    return JSON.parse(String(raw)) as LogMessage;
  } catch {
    return null;
  }
};

/** The viewer's text after a log_content (replaces it) or a log_append
 * (added, keeping the last MAX_BUFFER_LINES lines). */
const nextContent = (data: LogMessage, current: string | null) => {
  const text = String(data.content ?? '');
  return data.type === 'log_content' ? text : keepLastLines((current ?? '') + text, MAX_BUFFER_LINES);
};

/** The streamed file's details from a log_content/log_append message. */
const streamedMeta = (data: LogMessage, current: LogFileItem | null): LogFileItem => ({
  file: String(data.file),
  path: String(data.path ?? current?.path ?? ''),
  size_bytes: Number(data.size_bytes ?? 0),
  modified_at: String(data.modified_at ?? ''),
});

const streamFileMessage = (file: string, lines: number) =>
  JSON.stringify({ action: 'stream_file', file, lines });

/**
 * Keeps the log socket connected: reconnects with backoff - at once when the
 * browser is back online or the tab visible again - and closes a dead
 * connection (no message within WATCHDOG_MS). A denied connection
 * (DENIED_CODE) isn't retried. Returns the cleanup.
 */
const keepLogSocketConnected = ({
  onSocket,
  onStatus,
  onOpen,
  onMessage,
}: {
  /** The current socket; null once closed for good. */
  onSocket: (ws: WebSocket | null) => void;
  onStatus: (status: LogStreamStatus) => void;
  onOpen: (ws: WebSocket) => void;
  onMessage: (data: LogMessage, ws: WebSocket) => void;
}) => {
  let disposed = false;
  let attempt = 0;
  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;

  const armWatchdog = (ws: WebSocket) => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => ws.close(), WATCHDOG_MS);
  };

  const onClose = (event: CloseEvent) => {
    clearTimeout(watchdog);
    if (disposed) {
      return;
    }
    if (event.code === DENIED_CODE) {
      onStatus('denied');
      return;
    }
    onStatus('reconnecting');
    const delay = Math.min(RECONNECT_MIN_MS * 2 ** attempt, RECONNECT_MAX_MS);
    attempt += 1;
    reconnectTimer = setTimeout(connect, delay);
  };

  function connect() {
    if (disposed) {
      return;
    }
    const ws = new WebSocket(getWsBaseUrl().concat(WS_PATH));
    socket = ws;
    onSocket(ws);
    ws.onopen = () => {
      attempt = 0;
      onStatus('live');
      armWatchdog(ws);
      onOpen(ws);
    };
    ws.onmessage = (event) => {
      armWatchdog(ws);
      const data = parseMessage(event.data);
      if (data) {
        onMessage(data, ws);
      }
    };
    ws.onclose = onClose;
  }

  // Back online / tab visible again: don't wait for the backoff.
  const reconnectNow = () => {
    if (!disposed && (!socket || socket.readyState === WebSocket.CLOSED)) {
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
    onSocket(null);
    if (socket) {
      socket.onclose = null;
      socket.close();
    }
  };
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
  const latest = useRef({ lines, auth });
  useLayoutEffect(() => {
    latest.current = { lines, auth };
  });

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
      latest.current.auth,
      `/v1/status/admin/log_files/?file=${encodeURIComponent(file)}&lines=${latest.current.lines}`,
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
      latest.current.auth,
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
      if (!send({ action: 'stream_file', file, lines: latest.current.lines })) {
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
    /** The file list; without a selection its first file is streamed. */
    const receiveFiles = (list: LogFileItem[], ws: WebSocket) => {
      setFiles(list);
      if (!selectedRef.current && list.length > 0) {
        selectedRef.current = list[0].file;
        setSelected(list[0].file);
        ws.send(streamFileMessage(list[0].file, latest.current.lines));
      }
    };
    /** Content of the selected file - messages of a file switched away from are dropped. */
    const receiveLog = (data: LogMessage) => {
      if (data.file !== selectedRef.current) {
        return;
      }
      setContent((current) => nextContent(data, current));
      setMeta((current) => streamedMeta(data, current));
      setUpdatedAt(new Date());
      setError(null);
    };
    const handlers: Record<string, (data: LogMessage, ws: WebSocket) => void> = {
      file_list: (data, ws) => receiveFiles((data.files || []) as LogFileItem[], ws),
      log_content: receiveLog,
      log_append: receiveLog,
      error: (data) => setError(String(data.message ?? 'Error')),
    };

    return keepLogSocketConnected({
      onSocket: (ws) => {
        wsRef.current = ws;
      },
      onStatus: setStatus,
      onOpen: (ws) => {
        setError(null);
        ws.send(JSON.stringify({ action: 'list_files' }));
        if (selectedRef.current) {
          ws.send(streamFileMessage(selectedRef.current, latest.current.lines));
        }
      },
      onMessage: (data, ws) => handlers[String(data.type)]?.(data, ws),
    });
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
