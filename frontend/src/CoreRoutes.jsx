import React from 'react';
import { Route, Routes } from 'react-router';
import { WebSocketProvider } from './components/ws/websocketContext';

const Navbar = React.lazy(() => import('./components/navbar/Navbar'));
const LoginForm = React.lazy(() => import('./components/auth/LoginForm'));
const LandingPage = React.lazy(() => import('./main/LandingPage'));
const TokenTransit = React.lazy(() => import('./main/TokenTransit'));
const BackupView = React.lazy(() => import('./main/BackupView'));
const TokenLogin = React.lazy(() => import('./main/TokenLogin'));
const ChangeLogs = React.lazy(() => import('./main/ChangeLogs'));
const DevView = React.lazy(() => import('./main/DevView'));
const DemoView = React.lazy(() => import('./main/DemoView'));
const WsDebugView = React.lazy(() => import('./main/WsDebugView'));
const DeviceListView = React.lazy(() => import('./main/DeviceListView'));
const DeviceDetailView = React.lazy(() => import('./main/DeviceDetailView'));
const DeviceEditorView = React.lazy(() => import('./main/DeviceEditorView'));

const CoreRoutes = () => {
  return (
    <Routes>
      <Route path={`/login`} element={<LoginForm />} />

      <Route
        path="/demo"
        element={(
          <WebSocketProvider url="/ws/commands/list">
            <DemoView />
          </WebSocketProvider>
        )}
      />
      <Route path="/dev" element={<DevView />} />

      <Route
        path="/ws-debug"
        element={(
          <WebSocketProvider url="/ws/commands/list">
            <WsDebugView />
          </WebSocketProvider>
        )}
      />
      <Route
        path="/device/overview"
        element={(
          <WebSocketProvider url="/ws/commands/list">
            <Navbar act="device" content={<DeviceListView />} />
          </WebSocketProvider>
        )}
      />

      <Route
        path="/device/:id/update"
        element={<Navbar act="device" content={<DeviceDetailView />} />}
      />
      <Route
        path="/device/:id/editor/"
        element={<Navbar act="device" content={<DeviceEditorView />} />}
      />
      <Route path="*" element={<Navbar act={''} content={<LandingPage />} />} />
    </Routes>
  );
};
export default CoreRoutes;
