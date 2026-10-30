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
const DemoLogin = React.lazy(() => import('./main/DemoLogin.tsx'));
const MagicLinkRequest = React.lazy(
  () => import('./main/MagicLinkRequest.tsx'),
);
const MagicLinkLogin = React.lazy(() => import('./main/MagicLinkLogin.tsx'));
const PasswordResetRequest = React.lazy(
  () => import('./main/PasswordResetRequest.tsx'),
);
const PasswordResetConfirm = React.lazy(
  () => import('./main/PasswordResetConfirm.tsx'),
);
const TwoFactorSetupRequired = React.lazy(
  () => import('./main/TwoFactorSetupRequired.tsx'),
);
const RequestAccess = React.lazy(() => import('./main/RequestAccess.tsx'));
const VerifyAccess = React.lazy(() => import('./main/VerifyAccess.tsx'));
const PendingReview = React.lazy(() => import('./main/PendingReview.tsx'));
const PendingGate = React.lazy(() => import('./main/PendingGate.tsx'));
const DemoView = React.lazy(() => import('./main/DemoView.tsx'));
const PrivacyPolicyPage = React.lazy(
  () => import('./main/PrivacyPolicyPage.tsx'),
);
const ControllerQrCodePrintView = React.lazy(
  () => import('./main/ControllerQrCodePrintView.tsx'),
);
const TokenTransit = React.lazy(() => import('./main/TokenTransit'));
const BackupView = React.lazy(() => import('./main/BackupView'));
const TokenLogin = React.lazy(() => import('./main/TokenLogin'));
const ChangeLogs = React.lazy(() => import('./main/ChangeLogs'));
const DeveloperView = React.lazy(() => import('./main/DeveloperView.tsx'));
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
const LocationStatusTab = React.lazy(
  () => import('./main/LocationStatusTab.tsx'),
);
const LocationObjektTab = React.lazy(
  () => import('./main/LocationObjektTab.tsx'),
);
const LocationAnalyseTabRoute = React.lazy(
  () => import('./main/LocationAnalyseTab.tsx'),
);
const LocationNotificationsTabRoute = React.lazy(
  () => import('./main/LocationNotificationsTab.tsx'),
);
const LocationInterfaceTab = React.lazy(
  () => import('./main/LocationInterfaceTab.tsx'),
);
const LocationRechteTab = React.lazy(
  () => import('./main/LocationRechteTab.tsx'),
);
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
const DeviceSettingsRedirect = React.lazy(
  () => import('./main/DeviceSettingsRedirect.tsx'),
);
const DeviceEditorView = React.lazy(() => import('./main/DeviceEditorView'));
const MeasurementDetailView = React.lazy(
  () => import('./main/MeasurementDetailView'),
);
const AdminPanel = React.lazy(() => import('./main/AdminPanel.tsx'));
const StaffAdmin = React.lazy(() => import('./main/StaffAdmin.tsx'));
const EscalationsView = React.lazy(() => import('./main/EscalationsView.tsx'));
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
const LegacyImportView = React.lazy(
  () => import('./main/LegacyImportView.tsx'),
);
const DeviceProvisionView = React.lazy(
  () => import('./main/DeviceProvisionView.tsx'),
);
const LocationVerwaltungView = React.lazy(
  () => import('./main/LocationVerwaltungView.tsx'),
);
const LocationAnlegenView = React.lazy(
  () => import('./main/LocationAnlegenView.tsx'),
);

const CoreRoutes = () => {
  return (
    <Routes>
      <Route path={`/login`} element={<LoginForm />} />
      {/* One-time login link from a mail; redeemed on click, not on load. */}
      <Route path="/login/link" element={<MagicLinkRequest />} />
      <Route path="/login/link/:token" element={<MagicLinkLogin />} />
      {/* Password reset by mail link + 2FA code; set on click, not on load. */}
      <Route path="/passwort-vergessen" element={<PasswordResetRequest />} />
      <Route path="/passwort/neu/:token" element={<PasswordResetConfirm />} />
      {/* Staff who have to set up 2FA first see only this (PendingGate). */}
      <Route path="/konto/zwei-faktor" element={<TwoFactorSetupRequired />} />
      {/* Access request: form -> mail confirmation -> staff review. */}
      <Route path="/zugang/beantragen" element={<RequestAccess />} />
      <Route path="/zugang/bestaetigen/:token" element={<VerifyAccess />} />
      <Route path="/zugang/pruefung" element={<PendingReview />} />
      {/* Public demo: the link token logs in the read-only "demo" user. */}
      <Route path="/demo/login/:token" element={<DemoLogin />} />
      <Route path="/demo/" element={<DemoView />} />
      <Route path="/demo/location/:id" element={<DemoView />} />
      {/* Public - must stay reachable without login (GDPR information duty). */}
      <Route path="/datenschutz" element={<PrivacyPolicyPage />} />
      <Route path="/privacy" element={<Navigate to="/datenschutz" replace />} />
      {/* Print sheet - deliberately outside the layouts (no sidebar). */}
      <Route
        path="/setup/:account/controller/qrcodes/"
        element={<ControllerQrCodePrintView />}
      />

      {/* Users awaiting the review of their access request see only /zugang/pruefung. */}
      <Route element={<PendingGate />}>
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
          {/* Developer tools (sidebar: Tools > Developer), one tab each. */}
          <Route path="/developer" element={<DeveloperView />}>
            <Route index element={<Navigate to="docker/" replace />} />
            <Route path="docker/" element={<DockerStatusView />} />
            <Route path="legacy-import/" element={<LegacyImportView />} />
            <Route
              path="ws-debug/"
              element={
                <WebSocketProvider url="/ws/commands/list">
                  <WsDebugView />
                </WebSocketProvider>
              }
            />
            <Route path="dev/" element={<DevView />} />
          </Route>
          {/* Their former standalone paths. */}
          <Route
            path="/docker/"
            element={<Navigate to="/developer/docker/" replace />}
          />
          <Route
            path="/legacy/import/"
            element={<Navigate to="/developer/legacy-import/" replace />}
          />
          <Route
            path="/ws-debug"
            element={<Navigate to="/developer/ws-debug/" replace />}
          />
          <Route
            path="/dev"
            element={<Navigate to="/developer/dev/" replace />}
          />
          <Route path="/device/overview" element={<DeviceListView />} />
          <Route path="/alarms/" element={<AlarmsOverview />} />
          <Route path="/alarms/report/" element={<AlarmReportView />} />
          <Route
            path="/location/:id/heatplot"
            element={<LocationHeatplotView />}
          />
          <Route
            path="/locations/:id/heatplot"
            element={<LocationHeatplotView />}
          />
          <Route
            path="/location/:id/heatmap2d"
            element={<LocationHeatmap2DView />}
          />
          <Route
            path="/location/:id/alarms"
            element={<LocationAlarmDetail />}
          />
          {/* Retired: device config moved to /location/:id/einstellungen. */}
          <Route
            path="/device/:id/update/"
            element={<DeviceSettingsRedirect />}
          />
          <Route path="/device/:id/editor/" element={<DeviceEditorView />} />
          <Route path="/device/provision/" element={<DeviceProvisionView />} />
          <Route
            path="/device/:id/detail"
            element={<MeasurementDetailView />}
          />
          {/* The panel opens its own log-stream socket (admin/useLogStream). */}
          <Route path="/admin/panel/" element={<AdminPanel />} />
          <Route path="/staff/" element={<StaffAdmin />} />
          <Route path="/escalations/" element={<EscalationsView />} />
          <Route path="/escalations/:id" element={<EscalationsView />} />
          <Route path="/backup/:account/overview/" element={<BackupView />} />
          <Route path="/factory/" element={<FactoryVisualizerView />} />
          <Route path="/lageplan/wizard/" element={<LageplanWizardView />} />
          <Route path="/map/" element={<LocationsMapView />} />
          <Route path="/verwaltung/" element={<LocationVerwaltungView />} />
          <Route path="/anlegen/" element={<LocationAnlegenView />} />
          <Route path="*" element={<LandingPage />} />
        </Route>
      </Route>
    </Routes>
  );
};
export default CoreRoutes;
