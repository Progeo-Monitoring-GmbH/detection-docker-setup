import { useContext, useEffect, useRef, useState } from 'react';
import { getWsBaseUrl } from '../backendUrl';
import { WebsocketContext } from '../components/ws/websocketContext';
import { ReadyState } from '../components/ws/websocketContext';
import './WsDebugView.css';

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
  const wsUrl = `${getWsBaseUrl()}/ws/commands/list`;
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

  // The colours per state: .ws-debug-state--<state> in WsDebugView.css (idle / closed: grey).
  return (
    <div className="ws-debug-panel ws-debug-panel--spaced" data-testid="ws-debug-native">
      <h5 className="ws-debug-panel-title">Native WebSocket</h5>
      <div className="ws-debug-url" data-testid="ws-debug-native-url">
        URL: <code>{wsUrl}</code>
      </div>
      <div className="ws-debug-row">
        State:{' '}
        <span className={`ws-debug-state ws-debug-state--${nativeState}`} data-testid="ws-debug-native-state">
          {nativeState.toUpperCase()}
        </span>
      </div>
      <div className="ws-debug-buttons">
        <button className="btn btn-sm btn-primary" onClick={connect} data-testid="ws-debug-native-connect">Connect</button>
        <button className="btn btn-sm btn-secondary" onClick={disconnect} data-testid="ws-debug-native-disconnect">Disconnect</button>
        <button className="btn btn-sm btn-outline-success" onClick={sendPing} data-testid="ws-debug-native-ping">Send ping</button>
        <button className="btn btn-sm btn-outline-danger" onClick={() => setLog([])} data-testid="ws-debug-native-clear">Clear</button>
      </div>
      <pre className="ws-debug-log ws-debug-log--native" data-testid="ws-debug-native-log">
        {log.length === 0
          ? '— press Connect to start —'
          : log.map((e) => `[${e.time}] [${e.tag.toUpperCase().padEnd(5)}] ${e.text}`).join('\n')}
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
    if (!ctx) {return;}
    if (ctx.wsMessage !== prevMsg.current) {
      prevMsg.current = ctx.wsMessage;
      if (ctx.wsMessage !== null) {
        setLog((prev) => [
          ...prev,
          { time: ts(), tag: 'msg', text: JSON.stringify(ctx.wsMessage) },
        ]);
      }
    }
    // Per message only - the rest of ctx (readyState, ...) is not logged here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx?.wsMessage]);

  if (!ctx) {
    return (
      <div className="ws-debug-panel" data-testid="ws-debug-context">
        <h5 className="ws-debug-panel-title">WebsocketContext</h5>
        <div className="text-danger" data-testid="ws-debug-context-missing">
          Context is <strong>null</strong> — this view is not wrapped in{' '}
          <code>{'<WebSocketProvider>'}</code>.
        </div>
      </div>
    );
  }

  const stateLabel = READY_STATE_LABEL[ctx.readyState] ?? String(ctx.readyState);
  const stateClass =
    ctx.readyState === ReadyState.OPEN ? 'open' :
    ctx.readyState === ReadyState.CONNECTING ? 'connecting' : 'error';

  // An arrow function, not a hoisted declaration: keeps ctx narrowed to non-null.
  const sendPing = () => {
    const msg = JSON.stringify({ type: 'ping', ts: Date.now() });
    ctx.sendMessage(msg);
    setLog((prev) => [...prev, { time: ts(), tag: 'sent', text: msg }]);
  };

  return (
    <div className="ws-debug-panel" data-testid="ws-debug-context">
      <h5 className="ws-debug-panel-title">WebsocketContext (react-use-websocket)</h5>
      <div className="ws-debug-row">
        ReadyState:{' '}
        <span className={`ws-debug-state ws-debug-state--${stateClass}`} data-testid="ws-debug-context-state">
          {stateLabel} ({ctx.readyState})
        </span>
      </div>
      <div className="ws-debug-buttons">
        <button className="btn btn-sm btn-outline-success" onClick={sendPing} data-testid="ws-debug-context-ping">Send ping</button>
        <button className="btn btn-sm btn-outline-danger" onClick={() => setLog([])} data-testid="ws-debug-context-clear">Clear</button>
      </div>
      <div className="ws-debug-caption">
        Last wsMessage:
      </div>
      <pre className="ws-debug-log ws-debug-log--last" data-testid="ws-debug-context-last">
        {ctx.wsMessage == null ? 'null' : JSON.stringify(ctx.wsMessage, null, 2)}
      </pre>
      <div className="ws-debug-caption">Message log:</div>
      <pre className="ws-debug-log ws-debug-log--context" data-testid="ws-debug-context-log">
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
    <div className="ws-debug" data-testid="page-ws-debug">
      <h3 className="ws-debug-title">WebSocket Debug</h3>
      <p className="ws-debug-base" data-testid="ws-debug-base">
        WebSocket base = <code>{getWsBaseUrl()}</code>
      </p>

      <NativePanel />
      <ContextPanel />
    </div>
  );
};

export default WsDebugView;
