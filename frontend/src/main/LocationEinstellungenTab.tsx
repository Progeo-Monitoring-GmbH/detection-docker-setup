import { useTranslation } from 'react-i18next';
import PanelCard from '../components/ui/kit/PanelCard';

/**
 * "Einstellungen" placeholder: the mockup defines this screen's nav entry
 * and route (thresholds, system config, Objektleitung assignment), but its
 * content hasn't been built yet - a separate future pass, same as
 * Status/Objekt were.
 */
const LocationEinstellungenTab = () => {
  const { t } = useTranslation();
  return (
    <PanelCard>
      <div style={{ color: '#8B8383', fontSize: 13 }}>{t('einstell_coming_soon')}</div>
    </PanelCard>
  );
};

export default LocationEinstellungenTab;
