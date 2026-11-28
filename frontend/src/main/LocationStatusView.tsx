import { useCallback, useEffect, useMemo } from 'react';
import DeviceKindTabs, { useDeviceKindTab } from '../components/ui/DeviceKindTabs';
import type { DeviceKind, LocationDetail } from './locationTypes';
import { deviceKindsOf } from './projectType';
import { updateStatusView } from './statusViewState';
import { LATEST_RANGE } from './timeRanges';
import LocationClimatePanels from './LocationClimatePanels';
import LocationLeakStatusPanel from './LocationLeakStatusPanel';
import LocationStatusHeader from './LocationStatusHeader';
import { useStatusAccess } from './useStatusAccess';
import { useStatusLiveRevision } from './useStatusHistory';
import { useStatusViewSettings } from './useStatusViewSettings';
import './LocationStatusView.css';

const LEAK_ONLY: readonly DeviceKind[] = ['leak'];
const NO_KINDS: readonly DeviceKind[] = [];

type LocationStatusViewProps = {
  location: LocationDetail | null;
  locationId: number;
  /** Public demo view: reads /v1/demo/... and offers no write actions. */
  demo?: boolean;
};

/**
 * The status page of a location (/location/:id/status): the measurement
 * request header, the KPIs and the roof view / Zeitreihe
 * (LocationLeakStatusPanel) - smartex io objects show climate charts
 * instead, an object with both kinds of devices the tabs "Leckage" and
 * "Klima" (DeviceKindTabs: the hidden one preloads once the shown one is
 * there). Its settings come from the URL and are kept for an escalation
 * (useStatusViewSettings); new leak measurements jump to "Letzte Messung",
 * new data of either kind reloads its tab quietly (useStatusLiveRevision).
 */
const LocationStatusView = ({
  location,
  locationId,
  demo = false,
}: LocationStatusViewProps) => {
  const { readOnlyDemo, isStaff, canSeeMeasurements } = useStatusAccess(demo);
  const settings = useStatusViewSettings(isStaff);
  const { selectRange } = settings;
  // New leak measurements: the page shows them - "Letzte Messung". The
  // climate panels have no such range - their tab just reloads.
  const showLatest = useCallback(
    (kind: DeviceKind) => {
      if (kind === 'leak') {
        selectRange(LATEST_RANGE);
      }
    },
    [selectRange],
  );

  const kinds = useMemo(() => deviceKindsOf(location), [location]);
  const mixed = kinds.length > 1;
  const hasLeak = kinds.includes('leak');
  // Pure climate objects stay without live updates (as before).
  const liveKinds = demo ? NO_KINDS : mixed ? kinds : hasLeak ? LEAK_ONLY : NO_KINDS;
  const revisions = useStatusLiveRevision(locationId, liveKinds, canSeeMeasurements, showLatest);
  const [tab, setTab] = useDeviceKindTab(kinds);
  // An escalation takes the shown tab along (its quick link opens it).
  useEffect(() => {
    if (mixed) {
      updateStatusView(locationId, { tab: tab === 'climate' ? 'climate' : undefined });
    }
  }, [locationId, mixed, tab]);

  return (
    <div className="status-view" data-testid="page-location-status">
      <LocationStatusHeader
        locationId={locationId}
        canRequestMeasurement={hasLeak && !readOnlyDemo}
      />

      <DeviceKindTabs
        kinds={kinds}
        active={tab}
        onSelect={setTab}
        loadKey=""
        testId="status-tabs"
        renderPanel={(kind, panel) =>
          kind === 'leak' ? (
            <LocationLeakStatusPanel
              location={location}
              locationId={locationId}
              demo={demo}
              isStaff={isStaff}
              settings={settings}
              revision={revisions.leak}
              kind={mixed ? 'leak' : undefined}
              onReady={panel.onReady}
            />
          ) : (
            <LocationClimatePanels
              locationId={locationId}
              demo={demo}
              showBattery={isStaff}
              revision={revisions.climate}
              kind={mixed ? 'climate' : undefined}
              onReady={panel.onReady}
            />
          )
        }
      />
    </div>
  );
};

export default LocationStatusView;
