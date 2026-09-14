import { useTranslation } from 'react-i18next';
import PanelCard from '../components/ui/kit/PanelCard';

/**
 * "Berechtigungen" (Rechte) placeholder: the mockup defines this screen's
 * nav entry and route, but its content (per-object user roles/notification
 * channels) hasn't been built yet - a separate future pass, same as
 * Status/Objekt were.
 */
const LocationRechteTab = () => {
  const { t } = useTranslation();
  return (
    <PanelCard>
      <div style={{ color: '#8B8383', fontSize: 13 }}>{t('rechte_coming_soon')}</div>
    </PanelCard>
  );
};

export default LocationRechteTab;
