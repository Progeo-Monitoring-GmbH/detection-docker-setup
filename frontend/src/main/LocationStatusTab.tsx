import { useOutletContext } from 'react-router';
import LocationStatusView from './LocationStatusView';
import type { PortalOutletContext } from './LocationPortalLayout';

/**
 * Status route: KPI strip, roof-view heatmap and the Verdachtsstellen
 * (suspected-leak) list, per the Portal v2 mockup. location/locationId come
 * from LocationPortalLayout, which loads the location once for every
 * section route.
 */
const LocationStatusTab = () => {
  const { location, locationId } = useOutletContext<PortalOutletContext>();
  return <LocationStatusView key={locationId} location={location} locationId={locationId} />;
};

export default LocationStatusTab;
