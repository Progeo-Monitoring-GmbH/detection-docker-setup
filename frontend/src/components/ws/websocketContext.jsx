import React, { createContext, useCallback, useEffect, useRef, useState } from 'react';
import PropTypes from 'prop-types';

// Mirror the ReadyState values from the native WebSocket API.
export const ReadyState = {
  UNINSTANTIATED: -1,
  CONNECTING: WebSocket.CONNECTING,   // 0
  OPEN: WebSocket.OPEN,               // 1
  CLOSING: WebSocket.CLOSING,         // 2
  CLOSED: WebSocket.CLOSED,           // 3
};

const WebsocketContext = createContext([{}, () => {}]);

const RECONNECT_ATTEMPTS = 3;
const RECONNECT_INTERVAL_MS = 3000;

const WebSocketProvider = ({ children, url }) => {
  const fullUrl = import.meta.env.VITE_WS_URL.concat(url);
  const [readyState, setReadyState] = useState(ReadyState.UNINSTANTIATED);
  const [wsMessage, setWsMessage] = useState(null);
  const wsRef = useRef(null);
  const attemptsRef = useRef(0);
  const unmountedRef = useRef(false);
  const reconnectTimerRef = useRef(null);

  const connect = useCallback(() => {
    if (unmountedRef.current) return;

    const ws = new WebSocket(fullUrl);
    wsRef.current = ws;
    setReadyState(ReadyState.CONNECTING);

    ws.onopen = () => {
      attemptsRef.current = 0;
      setReadyState(ReadyState.OPEN);
    };

    ws.onmessage = (event) => {
      try {
        setWsMessage(JSON.parse(event.data));
      } catch {
        console.warn('WebsocketContext: failed to parse message:', event.data);
      }
    };

    ws.onclose = () => {
      setReadyState(ReadyState.CLOSED);
      if (unmountedRef.current) return;
      if (attemptsRef.current < RECONNECT_ATTEMPTS) {
        attemptsRef.current += 1;
        reconnectTimerRef.current = setTimeout(connect, RECONNECT_INTERVAL_MS);
      }
    };

    ws.onerror = () => {
      // onclose fires after onerror, so reconnect logic lives there.
      setReadyState(ReadyState.CLOSED);
    };
  }, [fullUrl]);

  useEffect(() => {
    connect();
    return () => {
      unmountedRef.current = true;
      clearTimeout(reconnectTimerRef.current);
      if (wsRef.current) {
        wsRef.current.onclose = null; // prevent reconnect on intentional close
        wsRef.current.close();
      }
    };
  }, [connect]);

  const sendMessage = useCallback((message) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(message);
    } else {
      console.warn('WebsocketContext: sendMessage called but socket is not open');
    }
  }, []);

  return (
    <WebsocketContext.Provider value={{ sendMessage, wsMessage, readyState }}>
      {children}
    </WebsocketContext.Provider>
  );
};

WebSocketProvider.propTypes = {
  children: PropTypes.element,
  url: PropTypes.string,
};

export { WebsocketContext, WebSocketProvider };
