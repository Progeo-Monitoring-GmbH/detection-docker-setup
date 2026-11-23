import type { LocationDetail } from './locationTypes';
import { isLorawanProject } from './projectType';
import LocationClimatePanels from './LocationClimatePanels';
import LocationStatusBody from './LocationStatusBody';
import LocationStatusHeader from './LocationStatusHeader';
import { useStatusAccess } from './useStatusAccess';
import {
  useStatusHistory,
  useStatusLiveRevision,
  useStatusRange,
} from './useStatusHistory';
import { useStatusSuspicions } from './useStatusSuspicions';
import {
  usePublishedStatusView,
  useStatusViewSettings,
} from './useStatusViewSettings';
import './LocationStatusView.css';

type LocationStatusViewProps = {
  location: LocationDetail | null;
  locationId: number;
  /** Public demo view: reads /v1/demo/... and offers no write actions. */
  demo?: boolean;
};

/**
 * The status page of a location (/location/:id/status): the measurement
 * request header, the KPIs and the roof view / Zeitreihe
 * (LocationStatusBody) - LoRaWAN objects show climate charts instead.
 * Its settings come from the URL and are kept for an escalation
 * (useStatusViewSettings); new measurements reload the data quietly
 * (useStatusLiveRevision).
 */
const LocationStatusView = ({
  location,
  locationId,
  demo = false,
}: LocationStatusViewProps) => {
  const { readOnlyDemo, isStaff } = useStatusAccess(demo);
  const settings = useStatusViewSettings(isStaff);

  // LoRaWAN objects have no samples (no heatmap, no Verdachtsstellen) - they
  // show humidity/temperature charts instead, see LocationClimatePanels.
  const isLorawan = isLorawanProject(location?.project_type);
  const liveRevision = useStatusLiveRevision(locationId, !demo && !isLorawan);
  const ranges = useStatusRange({
    locationId,
    demo,
    isLorawan,
    isStaff,
    selectedRange: settings.selectedRange,
    liveRevision,
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
    isLorawan,
    isLatest: ranges.isLatest,
    rangeDays: ranges.rangeDays,
    measurementRange: ranges.measurementRange,
    measurementRangeFailed: ranges.measurementRangeFailed,
    openedAt: settings.openedAt,
    heatProfile: settings.heatProfile,
    pickedStep: settings.pickedStep,
    rangeRevision: ranges.rangeRevision,
    liveRevision,
  });
  const suspicions = useStatusSuspicions({
    locationId,
    demo,
    isLorawan,
    isStaff,
    rangeDays: ranges.rangeDays,
    liveRevision,
  });

  return (
    <div className="status-view" data-testid="page-location-status">
      <LocationStatusHeader
        locationId={locationId}
        canRequestMeasurement={!isLorawan && !readOnlyDemo}
      />

      {isLorawan ? (
        <LocationClimatePanels
          locationId={locationId}
          demo={demo}
          showBattery={isStaff}
        />
      ) : (
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
      )}
    </div>
  );
};

export default LocationStatusView;
