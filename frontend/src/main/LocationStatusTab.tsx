import LocationAlarmDetail from './LocationAlarmDetail.tsx';
import type { LocationDetail } from './LocationDetailView';

type LocationStatusTabProps = {
  location: LocationDetail | null;
  locationId: number;
};

/**
 * Status tab: reuses the existing LocationAlarmDetail page (timeline, alarm
 * heatmap, alarm details). The location object is shared from the parent so
 * it is only loaded once.
 */
const LocationStatusTab = ({ location, locationId }: LocationStatusTabProps) => {
  return (
    <LocationAlarmDetail
      key={locationId}
      location={location}
      preloaded
    />
  );
};

export default LocationStatusTab;
