import React from 'react';
import { Route, Routes } from 'react-router';
import { WebSocketProvider } from './components/ws/websocketContext';

const Navbar = React.lazy(() => import('./components/navbar/Navbar'));
const NavbarEmpty = React.lazy(() => import('./components/navbar/NavbarEmpty'));
const LoginForm = React.lazy(() => import('./components/auth/LoginForm'));
const TokenTransit = React.lazy(() => import('./main/TokenTransit'));
const BackupView = React.lazy(() => import('./main/BackupView'));
const TokenLogin = React.lazy(() => import('./main/TokenLogin'));
const ChangeLogs = React.lazy(() => import('./main/ChangeLogs'));
const DevView = React.lazy(() => import('./main/DevView'));
const WsDebugView = React.lazy(() => import('./main/WsDebugView'));
const DockerStatusView = React.lazy(() => import('./main/DockerStatusView'));
const DeviceListView = React.lazy(() => import('./main/DeviceListView'));
const LocationsOverview = React.lazy(() => import('./main/LocationsOverview'));
const LocationHeatplotView = React.lazy(
  () => import('./main/LocationHeatplotView.tsx'),
);
const LocationHeatmap2DView = React.lazy(
  () => import('./main/LocationHeatmap2DView.tsx'),
);
const DeviceDetailView = React.lazy(() => import('./main/DeviceDetailView'));
const DeviceEditorView = React.lazy(() => import('./main/DeviceEditorView'));
const MeasurementDetailView = React.lazy(
  () => import('./main/MeasurementDetailView'),
);
const MeasurementsOverview = React.lazy(
  () => import('./main/MeasurementsOverview.tsx'),
);
const DisplayIMEIDevices = React.lazy(
  () => import('./main/DisplayIMEIDevices.tsx'),
);
const AdminPanel = React.lazy(() => import('./main/AdminPanel.tsx'));
const LandingPage = React.lazy(() => import('./main/LandingPage.tsx'));
const FactoryVisualizerView = React.lazy(
  () => import('./main/FactoryVisualizerView.tsx'),
);
const LageplanWizardView = React.lazy(
  () => import('./main/LageplanWizardView.tsx'),
);
const LocationsMapView = React.lazy(
  () => import('./main/LocationsMapView.jsx'),
);

const CoreRoutes = () => {
  return (
    <Routes>
      <Route path={`/login`} element={<LoginForm />} />

      <Route path="/dev" element={<DevView />} />

      <Route
        path="/ws-debug"
        element={
          <WebSocketProvider url="/ws/commands/list">
            <WsDebugView />
          </WebSocketProvider>
        }
      />
      <Route
        path="/device/overview"
        element={
          <WebSocketProvider url="/ws/commands/list">
            <Navbar act={'device'} content={<DeviceListView />} />
          </WebSocketProvider>
        }
      />
      <Route
        path="/location/overview/"
        element={<Navbar act={'location'} content={<LocationsOverview />} />}
      />
      <Route
        path="/location/:id/heatplot"
        element={<Navbar act={'location'} content={<LocationHeatplotView />} />}
      />
      <Route
        path="/locations/:id/heatplot"
        element={<Navbar act={'location'} content={<LocationHeatplotView />} />}
      />
      <Route
        path="/location/:id/heatmap2d"
        element={
          <Navbar act={'location'} content={<LocationHeatmap2DView />} />
        }
      />
      <Route
        path="/device/measure"
        element={
          <WebSocketProvider url="/ws/commands/list">
            <Navbar act={'measure'} content={<MeasurementsOverview />} />
          </WebSocketProvider>
        }
      />
      <Route
        path="/devices/imei/display/"
        element={
          <NavbarEmpty act={'measure'} content={<DisplayIMEIDevices />} />
        }
      />

      <Route
        path="/device/:id/update/"
        element={<Navbar act={'device'} content={<DeviceDetailView />} />}
      />
      <Route
        path="/device/:id/editor/"
        element={<Navbar act={'device'} content={<DeviceEditorView />} />}
      />
      <Route
        path="/device/:id/detail"
        element={<Navbar act={'device'} content={<MeasurementDetailView />} />}
      />
      <Route
        path="/docker/"
        element={<Navbar act={'docker'} content={<DockerStatusView />} />}
      />
      <Route
        path="/admin/panel/"
        element={
          <WebSocketProvider url="/ws/logs/stream/">
            <Navbar act={'adminpanel'} content={<AdminPanel />} />{' '}
          </WebSocketProvider>
        }
      />
      <Route
        path="/backup/:account/overview/"
        element={<Navbar act={'backup'} content={<BackupView />} />}
      />
      <Route
        path="/factory/"
        element={<Navbar act={'measure'} content={<FactoryVisualizerView />} />}
      />
      <Route
        path="/lageplan/wizard/"
        element={<Navbar act={'measure'} content={<LageplanWizardView />} />}
      />
      <Route
        path="/map/"
        element={<Navbar act={'location'} content={<LocationsMapView />} />}
      />
      <Route path="*" element={<LandingPage />} />
    </Routes>
  );
};
export default CoreRoutes;
