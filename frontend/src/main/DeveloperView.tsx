import { useTranslation } from 'react-i18next';
import { Outlet, useLocation, useNavigate } from 'react-router';
import SegmentedControl from '../components/ui/kit/SegmentedControl';

/** The tabs of /developer/ - one route segment each (see CoreRoutes). */
const DEVELOPER_TABS = [
  { segment: 'docker', labelKey: 'sidebar_docker' },
  { segment: 'legacy-import', labelKey: 'sidebar_legacy_import' },
  { segment: 'ws-debug', labelKey: 'sidebar_ws_debug' },
  { segment: 'dev', labelKey: 'sidebar_dev' },
] as const;

/**
 * "Developer" (sidebar: Tools): the superuser tooling that used to be four
 * separate sidebar items - Docker, Legacy Import, WS Debug and Dev - as tabs
 * over one <Outlet/>. The old paths redirect here (CoreRoutes).
 */
const DeveloperView = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { pathname } = useLocation();

  const current =
    DEVELOPER_TABS.find((tab) =>
      pathname.startsWith(`/developer/${tab.segment}`),
    )?.segment ?? DEVELOPER_TABS[0].segment;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ alignSelf: 'flex-start', maxWidth: '100%', overflowX: 'auto' }}>
        <SegmentedControl
          options={DEVELOPER_TABS.map((tab) => ({
            value: tab.segment,
            label: t(tab.labelKey),
          }))}
          value={current}
          onChange={(segment) => navigate(`/developer/${segment}/`)}
        />
      </div>
      <Outlet />
    </div>
  );
};

export default DeveloperView;
