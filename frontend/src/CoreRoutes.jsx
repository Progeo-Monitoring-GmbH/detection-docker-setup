import React from 'react';
import { Navigate, Route, Routes, useParams } from 'react-router';
import { WebSocketProvider } from './components/ws/websocketContext';
import { PORTAL_NAV_ITEMS } from './main/portalNav';

// The old tab-based /location/:id/detail/ route is replaced by
// /location/:id/status - redirect any stray bookmarks/links there.
const RedirectToStatus = () => {
  const { id } = useParams();
  return <Navigate to={`/location/${id}/status`} replace />;
};

const AppLayout = React.lazy(() => import('./main/AppLayout.tsx'));
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
const AlarmsOverview = React.lazy(() => import('./main/AlarmsOverview.tsx'));
const AlarmReportView = React.lazy(() => import('./main/AlarmReportView.tsx'));
const LocationHeatplotView = React.lazy(
  () => import('./main/LocationHeatplotView.tsx'),
);
const LocationHeatmap2DView = React.lazy(
  () => import('./main/LocationHeatmap2DView.tsx'),
);
const LocationAlarmDetail = React.lazy(
  () => import('./main/LocationAlarmDetail.tsx'),
);
const LocationPortalLayout = React.lazy(
  () => import('./main/LocationPortalLayout.tsx'),
);
const GuardedPortalPage = React.lazy(
  () => import('./main/GuardedPortalPage.tsx'),
);
const LocationStatusTab = React.lazy(() => import('./main/LocationStatusTab.tsx'));
const LocationObjektTab = React.lazy(() => import('./main/LocationObjektTab.tsx'));
const LocationAnalyseTabRoute = React.lazy(
  () => import('./main/LocationAnalyseTab.tsx'),
);
const LocationNotificationsTabRoute = React.lazy(
  () => import('./main/LocationNotificationsTab.tsx'),
);
const LocationInterfaceTab = React.lazy(
  () => import('./main/LocationInterfaceTab.tsx'),
);
const LocationRechteTab = React.lazy(() => import('./main/LocationRechteTab.tsx'));
const LocationEinstellungenTab = React.lazy(
  () => import('./main/LocationEinstellungenTab.tsx'),
);

// One content component per PORTAL_NAV_ITEMS key - kept next to the routes
// that mount them (portalNav.ts stays framework-agnostic: labels/icons/
// permissions/segments only).
const PORTAL_NAV_COMPONENTS = {
  status: LocationStatusTab,
  objekt: LocationObjektTab,
  analyse: LocationAnalyseTabRoute,
  benach: LocationNotificationsTabRoute,
  rechte: LocationRechteTab,
  einstell: LocationEinstellungenTab,
  schnittstelle: LocationInterfaceTab,
};
const DeviceDetailView = React.lazy(() => import('./main/DeviceDetailView'));
const DeviceEditorView = React.lazy(() => import('./main/DeviceEditorView'));
const MeasurementDetailView = React.lazy(
  () => import('./main/MeasurementDetailView'),
);
const AdminPanel = React.lazy(() => import('./main/AdminPanel.tsx'));
const StaffAdmin = React.lazy(() => import('./main/StaffAdmin.tsx'));
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
const LegacyImportView = React.lazy(() => import('./main/LegacyImportView.tsx'));

const CoreRoutes = () => {
  return (
    <Routes>
      <Route path={`/login`} element={<LoginForm />} />

      {/* Object/location monitoring portal - its own mockup-driven sidebar. */}
      <Route element={<LocationPortalLayout />}>
        <Route path="/location/overview/" element={<LocationsOverview />} />
        {PORTAL_NAV_ITEMS.map((item) => (
          <Route
            key={item.key}
            path={`/location/:id/${item.segment}`}
            element={
              <GuardedPortalPage item={item}>
                {React.createElement(PORTAL_NAV_COMPONENTS[item.key])}
              </GuardedPortalPage>
            }
          />
        ))}
        <Route path="/location/:id/detail/" element={<RedirectToStatus />} />
      </Route>

      {/* Everything else - the general-purpose sidebar (ported 1:1 from the
          retired Navbar.jsx's item list). */}
      <Route element={<AppLayout />}>
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
              <DeviceListView />
            </WebSocketProvider>
          }
        />
        <Route path="/alarms/" element={<AlarmsOverview />} />
        <Route path="/alarms/report/" element={<AlarmReportView />} />
        <Route path="/location/:id/heatplot" element={<LocationHeatplotView />} />
        <Route path="/locations/:id/heatplot" element={<LocationHeatplotView />} />
        <Route path="/location/:id/heatmap2d" element={<LocationHeatmap2DView />} />
        <Route path="/location/:id/alarms" element={<LocationAlarmDetail />} />
        <Route path="/device/:id/update/" element={<DeviceDetailView />} />
        <Route path="/device/:id/editor/" element={<DeviceEditorView />} />
        <Route path="/device/:id/detail" element={<MeasurementDetailView />} />
        <Route path="/docker/" element={<DockerStatusView />} />
        <Route
          path="/admin/panel/"
          element={
            <WebSocketProvider url="/ws/logs/stream/">
              <AdminPanel />
            </WebSocketProvider>
          }
        />
        <Route path="/staff/" element={<StaffAdmin />} />
        <Route path="/backup/:account/overview/" element={<BackupView />} />
        <Route path="/factory/" element={<FactoryVisualizerView />} />
        <Route path="/lageplan/wizard/" element={<LageplanWizardView />} />
        <Route path="/legacy/import/" element={<LegacyImportView />} />
        <Route path="/map/" element={<LocationsMapView />} />
        <Route path="*" element={<LandingPage />} />
      </Route>
    </Routes>
  );
};
export default CoreRoutes;
