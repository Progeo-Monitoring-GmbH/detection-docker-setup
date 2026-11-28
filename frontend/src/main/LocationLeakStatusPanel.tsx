import { useEffect } from 'react';
import type { DeviceKind, LocationDetail } from './locationTypes';
import LocationStatusBody from './LocationStatusBody';
import { useStatusHistory, useStatusRange } from './useStatusHistory';
import { useStatusSuspicions } from './useStatusSuspicions';
import {
  usePublishedStatusView,
  type useStatusViewSettings,
} from './useStatusViewSettings';

type LocationLeakStatusPanelProps = {
  location: LocationDetail | null;
  locationId: number;
  demo: boolean;
  isStaff: boolean;
  /** The page's settings (view, range, step, ...) - the page jumps to
   * "Letzte Messung" on new data through them. */
  settings: ReturnType<typeof useStatusViewSettings>;
  /** Goes up with new leak data (useStatusLiveRevision). */
  revision: number;
  /** "leak" in a location with climate sensors too: only the leak devices'
   * range, history and frames - without it all devices (as before). */
  kind?: DeviceKind;
  /** The history is there (or refused / failed) - the other tab loads then. */
  onReady: () => void;
};

/**
 * The leak view of the status page: the KPIs and the roof view / Zeitreihe
 * (LocationStatusBody) with what they load - mounted only when its tab
 * shows (or preloads), so a hidden one requests nothing before.
 */
const LocationLeakStatusPanel = ({
  location,
  locationId,
  demo,
  isStaff,
  settings,
  revision,
  kind,
  onReady,
}: LocationLeakStatusPanelProps) => {
  const ranges = useStatusRange({
    locationId,
    demo,
    isSmartexIo: false,
    isStaff,
    selectedRange: settings.selectedRange,
    liveRevision: revision,
    kind,
  });
  const { onFrameTimeChange, onZeitreiheShown } = usePublishedStatusView(
    locationId,
    {
      view: settings.statusView,
      range: ranges.range,
      step: settings.pickedStep,
      sensor: settings.selectedSensor,
      profile: settings.heatProfile,
    },
  );
  const shown = useStatusHistory({
    locationId,
    demo,
    isSmartexIo: false,
    isLatest: ranges.isLatest,
    rangeDays: ranges.rangeDays,
    measurementRange: ranges.measurementRange,
    measurementRangeFailed: ranges.measurementRangeFailed,
    openedAt: settings.openedAt,
    heatProfile: settings.heatProfile,
    pickedStep: settings.pickedStep,
    rangeRevision: ranges.rangeRevision,
    liveRevision: revision,
    kind,
  });
  const suspicions = useStatusSuspicions({
    locationId,
    demo,
    isSmartexIo: false,
    isStaff,
    rangeDays: ranges.rangeDays,
    liveRevision: revision,
  });

  // A refused or failed history ends the loading too - an empty tab must not
  // keep the other one waiting.
  useEffect(() => {
    if (!shown.loading) {
      onReady();
    }
  }, [onReady, shown.loading]);

  return (
    <LocationStatusBody
      location={location}
      locationId={locationId}
      demo={demo}
      isStaff={isStaff}
      settings={settings}
      ranges={ranges}
      shown={shown}
      suspicions={suspicions}
      onFrameTimeChange={onFrameTimeChange}
      onZeitreiheShown={onZeitreiheShown}
    />
  );
};

export default LocationLeakStatusPanel;
