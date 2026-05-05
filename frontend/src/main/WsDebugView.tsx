import { useContext, useEffect, useRef, useState } from 'react';
import { WebsocketContext } from '../components/ws/websocketContext';
import { ReadyState } from '../components/ws/websocketContext';

const READY_STATE_LABEL: Record<number, string> = {
  [ReadyState.CONNECTING]: 'CONNECTING',
  [ReadyState.OPEN]: 'OPEN',
  [ReadyState.CLOSING]: 'CLOSING',
  [ReadyState.CLOSED]: 'CLOSED',
  [ReadyState.UNINSTANTIATED]: 'UNINSTANTIATED',
};

type LogEntry = { time: string; tag: string; text: string };

function ts() {
  return new Date().toISOString().slice(11, 23);
}

// ─── Native WS panel ─────────────────────────────────────────────────────────
function NativePanel() {
  const wsUrl = `${import.meta.env.VITE_WS_URL as string}/ws/commands/list`;
  const [log, setLog] = useState<LogEntry[]>([]);
  const [nativeState, setNativeState] = useState<string>('idle');
  const wsRef = useRef<WebSocket | null>(null);

  function addLog(tag: string, text: string) {
    setLog((prev) => [...prev, { time: ts(), tag, text }]);
  }

  function connect() {
    if (wsRef.current) {
      wsRef.current.close();
    }
    addLog('info', `Connecting to ${wsUrl}`);
    setNativeState('connecting');
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setNativeState('open');
      addLog('open', 'Connection established');
    };
    ws.onmessage = (e) => {
      addLog('msg', e.data as string);
    };
    ws.onerror = (e) => {
      setNativeState('error');
      addLog('error', `WebSocket error — check console for details`);
      console.error('WsDebugView native error:', e);
    };
    ws.onclose = (e) => {
      setNativeState('closed');
      addLog('close', `Closed — code=${e.code} reason=${e.reason || '(none)'} wasClean=${String(e.wasClean)}`);
    };
  }

  function disconnect() {
    wsRef.current?.close();
  }

  function sendPing() {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const msg = JSON.stringify({ type: 'ping', ts: Date.now() });
      wsRef.current.send(msg);
      addLog('sent', msg);
    } else {
      addLog('warn', 'Cannot send — socket not open');
    }
  }

  useEffect(() => () => { wsRef.current?.close(); }, []);

  const stateColor: Record<string, string> = {
    idle: '#888', connecting: '#f0a500', open: '#4caf50', error: '#f44336', closed: '#888',
  };

  return (
    <div style={{ border: '1px solid #333', borderRadius: 6, padding: 16, marginBottom: 24 }}>
      <h5 style={{ marginTop: 0 }}>Native WebSocket</h5>
      <div style={{ marginBottom: 8 }}>
        URL: <code>{wsUrl}</code>
      </div>
      <div style={{ marginBottom: 12 }}>
        State:{' '}
        <span style={{ fontWeight: 'bold', color: stateColor[nativeState] ?? '#888' }}>
          {nativeState.toUpperCase()}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <button className="btn btn-sm btn-primary" onClick={connect}>Connect</button>
        <button className="btn btn-sm btn-secondary" onClick={disconnect}>Disconnect</button>
        <button className="btn btn-sm btn-outline-success" onClick={sendPing}>Send ping</button>
        <button className="btn btn-sm btn-outline-danger" onClick={() => setLog([])}>Clear</button>
      </div>
      <pre style={{ background: '#111', color: '#ddd', padding: 12, borderRadius: 4, minHeight: 120, maxHeight: 280, overflowY: 'auto', fontSize: 12 }}>
        {log.length === 0
          ? '— press Connect to start —'
          : log.map((e, i) => `[${e.time}] [${e.tag.toUpperCase().padEnd(5)}] ${e.text}`).join('\n')}
      </pre>
    </div>
  );
}

// ─── Context panel ────────────────────────────────────────────────────────────
function ContextPanel() {
  const ctx = useContext(WebsocketContext) as {
    wsMessage: unknown;
    readyState: number;
    sendMessage: (msg: string) => void;
  } | null;

  const [log, setLog] = useState<LogEntry[]>([]);
  const prevMsg = useRef<unknown>(null);

  useEffect(() => {
    if (!ctx) return;
    if (ctx.wsMessage !== prevMsg.current) {
      prevMsg.current = ctx.wsMessage;
      if (ctx.wsMessage !== null) {
        setLog((prev) => [
          ...prev,
          { time: ts(), tag: 'msg', text: JSON.stringify(ctx.wsMessage) },
        ]);
      }
    }
  }, [ctx?.wsMessage]);

  if (!ctx) {
    return (
      <div style={{ border: '1px solid #333', borderRadius: 6, padding: 16 }}>
        <h5 style={{ marginTop: 0 }}>WebsocketContext</h5>
        <div className="text-danger">
          Context is <strong>null</strong> — this view is not wrapped in{' '}
          <code>{'<WebSocketProvider>'}</code>.
        </div>
      </div>
    );
  }

  const stateLabel = READY_STATE_LABEL[ctx.readyState] ?? String(ctx.readyState);
  const stateColor =
    ctx.readyState === ReadyState.OPEN ? '#4caf50' :
    ctx.readyState === ReadyState.CONNECTING ? '#f0a500' : '#f44336';

  function sendPing() {
    const msg = JSON.stringify({ type: 'ping', ts: Date.now() });
    ctx.sendMessage(msg);
    setLog((prev) => [...prev, { time: ts(), tag: 'sent', text: msg }]);
  }

  return (
    <div style={{ border: '1px solid #333', borderRadius: 6, padding: 16 }}>
      <h5 style={{ marginTop: 0 }}>WebsocketContext (react-use-websocket)</h5>
      <div style={{ marginBottom: 12 }}>
        ReadyState:{' '}
        <span style={{ fontWeight: 'bold', color: stateColor }}>
          {stateLabel} ({ctx.readyState})
        </span>
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <button className="btn btn-sm btn-outline-success" onClick={sendPing}>Send ping</button>
        <button className="btn btn-sm btn-outline-danger" onClick={() => setLog([])}>Clear</button>
      </div>
      <div style={{ marginBottom: 6, fontSize: 12, color: '#aaa' }}>
        Last wsMessage:
      </div>
      <pre style={{ background: '#111', color: '#ddd', padding: 12, borderRadius: 4, minHeight: 60, maxHeight: 120, overflowY: 'auto', fontSize: 12, marginBottom: 12 }}>
        {ctx.wsMessage == null ? 'null' : JSON.stringify(ctx.wsMessage, null, 2)}
      </pre>
      <div style={{ fontSize: 12, color: '#aaa', marginBottom: 6 }}>Message log:</div>
      <pre style={{ background: '#111', color: '#ddd', padding: 12, borderRadius: 4, minHeight: 60, maxHeight: 200, overflowY: 'auto', fontSize: 12 }}>
        {log.length === 0
          ? '— waiting for messages —'
          : log.map((e) => `[${e.time}] [${e.tag.toUpperCase().padEnd(5)}] ${e.text}`).join('\n')}
      </pre>
    </div>
  );
}

// ─── Main view ────────────────────────────────────────────────────────────────
const WsDebugView = () => {
  return (
    <div style={{ padding: '1.5rem', maxWidth: 900 }}>
      <h3 style={{ marginBottom: '0.25rem' }}>WebSocket Debug</h3>
      <p style={{ color: '#888', marginBottom: '1.5rem', fontSize: 13 }}>
        VITE_WS_URL = <code>{import.meta.env.VITE_WS_URL as string}</code>
      </p>

      <NativePanel />
      <ContextPanel />
    </div>
  );
};

export default WsDebugView;
