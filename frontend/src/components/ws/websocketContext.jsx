import React, { useCallback, createContext, useEffect, useRef } from 'react';
import useWebSocket from 'react-use-websocket';
import PropTypes from 'prop-types';

const WebsocketContext = createContext([{}, () => {}]);

const WebSocketProvider = ({ children, url }) => {
  const getSocketUrl = useCallback(() => {
    const fullUrl = import.meta.env.VITE_WS_URL.concat(url);
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve(fullUrl);
      }, 2000);
    });
  }, []);

  const didUnmount = useRef(false);
  const { sendMessage, lastMessage, readyState } = useWebSocket(getSocketUrl, {
    shouldReconnect: () => {
      return didUnmount.current === false;
    },
    reconnectAttempts: 3,
    reconnectInterval: 3000,
  });

  useEffect(() => {
    return () => {
      didUnmount.current = true;
    };
  }, []);

  const wsMessage = lastMessage !== null ? JSON.parse(lastMessage.data) : null;

  return (
    <>
      <WebsocketContext.Provider value={{ sendMessage, wsMessage, readyState }}>
        {children}
      </WebsocketContext.Provider>
    </>
  );
};
// See: https://reactjs.org/docs/typechecking-with-proptypes.html
WebSocketProvider.propTypes = {
  children: PropTypes.element,
  url: PropTypes.string,
};

export { WebsocketContext, WebSocketProvider };
