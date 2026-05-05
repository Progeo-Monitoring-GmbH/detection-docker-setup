import './../components/ui/css/Dev.css';
import React from 'react';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import { WebsocketContext } from '../components/ws/websocketContext';

const DevView = () => {
  const auth = useAuth();
  return (
    <div>
      Dev!
      <br />
    </div>
  );
};

export default DevView;
