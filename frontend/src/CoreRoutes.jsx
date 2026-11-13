import React from 'react';
import { Navigate, Route, Routes, useParams } from 'react-router';
import { WebSocketProvider } from './components/ws/websocketContext';
import { routeRule } from './main/access';
import { PORTAL_NAV_ITEMS } from './main/portalNav';
import RequireAccess from './main/RequireAccess';

// Every page below the layouts goes through its rule in APP_ROUTE_ACCESS
// (access.ts; access.spec.ts checks no route is left out). `path` must be
// the route's own.
const guard = (path, element) => (
  <RequireAccess rule={routeRule(path)}>{element}</RequireAccess>
);

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
};
const DeviceSettingsRedirect = React.lazy(
  () => import('./main/DeviceSettingsRedirect.tsx'),
);
const AdminPanel = React.lazy(() => import('./main/AdminPanel.tsx'));
const StaffAdmin = React.lazy(() => import('./main/StaffAdmin.tsx'));
const DatabaseUsageView = React.lazy(() => import('./main/staff/DatabaseUsageView.tsx'));
const UserActivityView = React.lazy(() => import('./main/staff/UserActivityView.tsx'));
const EscalationsView = React.lazy(() => import('./main/EscalationsView.tsx'));
const LandingPage = React.lazy(() => import('./main/LandingPage.tsx'));
const LageplanWizardView = React.lazy(
  () => import('./main/LageplanWizardView.tsx'),
);
const LocationsMapView = React.lazy(
  () => import('./main/LocationsMapView.jsx'),
);
const LegacyImportView = React.lazy(
  () => import('./main/LegacyImportView.tsx'),
);
const DeviceStatisticsView = React.lazy(
  () => import('./main/DeviceStatisticsView.tsx'),
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
          <Route
            path="/location/overview/"
            element={guard('/location/overview/', <LocationsOverview />)}
          />
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
          {/* Was a portal tab, but the interface config is system-wide. */}
          <Route
            path="/location/:id/schnittstelle"
            element={<Navigate to="/schnittstelle/" replace />}
          />
        </Route>

        {/* Everything else - the general-purpose sidebar (ported 1:1 from the
          retired Navbar.jsx's item list). */}
        <Route element={<AppLayout />}>
          {/* Developer tools (sidebar: Tools > Developer), one tab each. */}
          <Route
            path="/developer"
            element={guard('/developer', <DeveloperView />)}
          >
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
          <Route
            path="/device/overview"
            element={guard('/device/overview', <DeviceListView />)}
          />
          <Route
            path="/alarms/"
            element={guard('/alarms/', <AlarmsOverview />)}
          />
          <Route
            path="/alarms/report/"
            element={guard('/alarms/report/', <AlarmReportView />)}
          />
          <Route
            path="/location/:id/heatplot"
            element={guard('/location/:id/heatplot', <LocationHeatplotView />)}
          />
          <Route
            path="/locations/:id/heatplot"
            element={guard('/locations/:id/heatplot', <LocationHeatplotView />)}
          />
          <Route
            path="/location/:id/heatmap2d"
            element={guard(
              '/location/:id/heatmap2d',
              <LocationHeatmap2DView />,
            )}
          />
          <Route
            path="/location/:id/alarms"
            element={guard('/location/:id/alarms', <LocationAlarmDetail />)}
          />
          {/* Retired: device config moved to /location/:id/einstellungen. */}
          <Route
            path="/device/:id/update/"
            element={guard('/device/:id/update/', <DeviceSettingsRedirect />)}
          />
          {/* Retired: the device setup is part of the device overview. */}
          <Route
            path="/device/provision/"
            element={<Navigate to="/device/overview" replace />}
          />
          <Route
            path="/device/statistics/"
            element={guard('/device/statistics/', <DeviceStatisticsView />)}
          />
          {/* The panel opens its own log-stream socket (admin/useLogStream). */}
          <Route
            path="/admin/panel/"
            element={guard('/admin/panel/', <AdminPanel />)}
          />
          <Route path="/staff/" element={guard('/staff/', <StaffAdmin />)} />
          {/* Staff insights: how the project databases and the portal are used. */}
          <Route
            path="/insights/databases/"
            element={guard('/insights/databases/', <DatabaseUsageView />)}
          />
          <Route
            path="/insights/activity/"
            element={guard('/insights/activity/', <UserActivityView />)}
          />
          {/* System-wide SMTP/Modbus/SMS/messenger config - not per location. */}
          <Route
            path="/schnittstelle/"
            element={guard('/schnittstelle/', <LocationInterfaceTab />)}
          />
          <Route
            path="/escalations/"
            element={guard('/escalations/', <EscalationsView />)}
          />
          <Route
            path="/escalations/:id"
            element={guard('/escalations/:id', <EscalationsView />)}
          />
          <Route
            path="/backup/:account/overview/"
            element={guard('/backup/:account/overview/', <BackupView />)}
          />
          <Route
            path="/lageplan/wizard/"
            element={guard('/lageplan/wizard/', <LageplanWizardView />)}
          />
          <Route path="/map/" element={guard('/map/', <LocationsMapView />)} />
          <Route
            path="/verwaltung/"
            element={guard('/verwaltung/', <LocationVerwaltungView />)}
          />
          <Route
            path="/anlegen/"
            element={guard('/anlegen/', <LocationAnlegenView />)}
          />
          <Route path="*" element={guard('*', <LandingPage />)} />
        </Route>
      </Route>
    </Routes>
  );
};
export default CoreRoutes;
