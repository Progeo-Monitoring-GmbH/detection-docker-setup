import { useCallback } from 'react';
import type { LocationDetail } from './locationTypes';
import { isSmartexIoProject } from './projectType';
import { LATEST_RANGE } from './timeRanges';
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
 * (LocationStatusBody) - smartex io objects show climate charts instead.
 * Its settings come from the URL and are kept for an escalation
 * (useStatusViewSettings); new measurements jump to "Letzte Messung" and
 * reload the data quietly (useStatusLiveRevision).
 */
const LocationStatusView = ({
  location,
  locationId,
  demo = false,
}: LocationStatusViewProps) => {
  const { readOnlyDemo, isStaff, canSeeMeasurements } = useStatusAccess(demo);
  const settings = useStatusViewSettings(isStaff);
  const { selectRange } = settings;
  // New measurements: the page shows them - "Letzte Messung".
  const showLatest = useCallback(() => selectRange(LATEST_RANGE), [selectRange]);

  // smartex io objects have no samples (no heatmap, no Verdachtsstellen) - they
  // show humidity/temperature charts instead, see LocationClimatePanels.
  const isSmartexIo = isSmartexIoProject(location?.project_type);
  const liveRevision = useStatusLiveRevision(
    locationId,
    !demo && !isSmartexIo,
    canSeeMeasurements,
    showLatest,
  );
  const ranges = useStatusRange({
    locationId,
    demo,
    isSmartexIo,
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
    isSmartexIo,
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
    isSmartexIo,
    isStaff,
    rangeDays: ranges.rangeDays,
    liveRevision,
  });

  return (
    <div className="status-view" data-testid="page-location-status">
      <LocationStatusHeader
        locationId={locationId}
        canRequestMeasurement={!isSmartexIo && !readOnlyDemo}
      />

      {isSmartexIo ? (
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
