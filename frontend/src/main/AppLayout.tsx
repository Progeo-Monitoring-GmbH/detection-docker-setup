import { Outlet } from 'react-router';
import LocationSidebar from '../components/sidebar/LocationSidebar';
import TopBar from '../components/topbar/TopBar';

/**
 * Layout for every route outside the object/location monitoring portal
 * (LocationPortalLayout): the same sidebar, just without an open location,
 * so it needs no per-route data - it's just chrome + <Outlet/>.
 */
const AppLayout = () => {
  const mobile = typeof window !== 'undefined' && window.innerWidth < 860;

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: mobile ? 'column' : 'row',
        background: 'var(--progeo-page-bg)',
      }}
    >
      <LocationSidebar />
      <div
        style={{
          flex: 1,
          minWidth: 0,
          padding: mobile ? '4px 12px 20px' : '20px 20px 22px 6px',
        }}
      >
        <TopBar />
        <div style={{ marginTop: 14 }}>
          <Outlet />
        </div>
      </div>
    </div>
  );
};

export default AppLayout;
