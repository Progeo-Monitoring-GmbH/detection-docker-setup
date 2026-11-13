import { Outlet } from 'react-router';
import LocationSidebar from '../components/sidebar/LocationSidebar';
import TopBar from '../components/topbar/TopBar';
import FavoritesBar from './FavoritesBar';
import ImpersonationBanner from './ImpersonationBanner';
import './AppLayout.css';

/**
 * Layout for every route outside the object/location monitoring portal
 * (LocationPortalLayout): the same sidebar, just without an open location,
 * so it needs no per-route data - it's just chrome + <Outlet/>.
 */
const AppLayout = () => {
  const mobile = typeof window !== 'undefined' && window.innerWidth < 860;

  return (
    <div className={`app-layout${mobile ? ' app-layout--mobile' : ''}`} data-testid="app-layout">
      <LocationSidebar />
      <div className="app-layout-content">
        <TopBar />
        <div className="app-layout-spaced">
          <ImpersonationBanner />
        </div>
        <FavoritesBar className="app-layout-spaced" />
        <div className="app-layout-spaced" data-testid="app-content">
          <Outlet />
        </div>
      </div>
    </div>
  );
};

export default AppLayout;
