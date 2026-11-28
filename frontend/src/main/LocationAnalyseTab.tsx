import { useOutletContext } from 'react-router';
import DeviceKindTabs, { useDeviceKindTab } from '../components/ui/DeviceKindTabs';
import type { PortalOutletContext } from './LocationPortalLayout';
import AnalysePanel from './AnalysePanel';
import { useAnalyseAccess, useAnalysePeriod } from './useAnalyseSettings';
import './LocationAnalyseTab.css';

/**
 * Analyse route: the location heatmap plus the measurements of all its
 * devices over the selected period (last 24 h / 7 / 30 days; staff also the
 * last quarter, half year and year) - only periods the data reaches into.
 * smartex io objects get their climate heatmap and charts instead; an
 * object with both kinds of devices the tabs "Leckage" and "Klima"
 * (DeviceKindTabs) with one period for both: a new one loads in the shown
 * tab first, the hidden one follows once it is there. Each kind is an
 * AnalysePanel.
 */
const LocationAnalyseTab = () => {
  const { location, locationId } = useOutletContext<PortalOutletContext>();
  const access = useAnalyseAccess(location);
  const { kinds } = access;
  const [tab, setTab] = useDeviceKindTab(kinds);
  const mixed = kinds.length > 1;
  // One period for both tabs - offered as far as the shown tab's data reaches.
  const period = useAnalysePeriod(locationId, access.isStaff, mixed ? tab : undefined);

  return (
    <div className="d-flex flex-column gap-4" data-testid="page-location-analyse">
      <DeviceKindTabs
        kinds={kinds}
        active={tab}
        onSelect={setTab}
        loadKey={period.range}
        testId="analyse-tabs"
        renderPanel={(kind, panel) => (
          <AnalysePanel
            location={location}
            locationId={locationId}
            kind={kind}
            mixed={mixed}
            range={panel.loadKey}
            access={access}
            period={period}
            onReady={panel.onReady}
            visible={panel.visible}
          />
        )}
      />
    </div>
  );
};

export default LocationAnalyseTab;
