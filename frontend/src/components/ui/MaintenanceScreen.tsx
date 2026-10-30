import React, { useEffect, useSyncExternalStore } from 'react';
import {
  isMaintenance,
  startMaintenanceWatch,
  subscribeMaintenance,
} from '../../maintenance';
import './MaintenanceScreen.css';

/** "Wartungsarbeiten" in place of the app while the backend is gone. Like
 * nginx's page in German and English - it may show before the
 * translations have loaded. */
function MaintenanceScreen() {
  return (
    <div className="maintenance-screen">
      <main>
        <div className="maintenance-card" role="status" aria-live="polite">
          <img
            className="maintenance-logo"
            src="/assets/progeo-logo.png"
            alt="ProGeo"
          />
          <h1>Wartungsarbeiten</h1>
          <p>
            Das System wird gerade gestartet oder aktualisiert und ist in
            wenigen Minuten wieder für Sie da.
          </p>
          <p className="maintenance-en">
            We are currently performing maintenance. The system will be back in
            a few minutes.
          </p>
          <div className="maintenance-progress" aria-hidden="true"></div>
          <p className="maintenance-status">
            Die Seite lädt automatisch neu, sobald das System wieder erreichbar
            ist.
          </p>
        </div>
      </main>
      <footer>
        &copy; ProGeo &middot;{' '}
        <a href="https://www.progeo.com">www.progeo.com</a>
      </footer>
    </div>
  );
}

/** Renders the app, or the maintenance screen while the backend is gone -
 * the app is unmounted then, so its requests and sockets stop. */
export default function MaintenanceGate({
  children,
}: {
  children: React.ReactNode;
}) {
  const maintenance = useSyncExternalStore(subscribeMaintenance, isMaintenance);
  useEffect(() => startMaintenanceWatch(), []);
  return maintenance ? <MaintenanceScreen /> : <>{children}</>;
}
