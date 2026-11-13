import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useLocation as useRouterLocation } from 'react-router';
import { ChevronDoubleLeft, ChevronDoubleRight, List, X } from 'react-bootstrap-icons';
// The look of the shell, the nav links (.progeo-sidebar-item) and these buttons.
import './Sidebar.css';

const MOBILE_BREAKPOINT = 860;
/** Width of the folded desktop sidebar: the nav icons only. */
const SIDEBAR_COLLAPSED_WIDTH = 64;
// Per browser - a convenience, so storage failures (private mode) are ignored.
const COLLAPSED_STORAGE_KEY = 'progeo.sidebar.collapsed';

const readCollapsed = () => {
  try {
    return window.localStorage.getItem(COLLAPSED_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
};

const storeCollapsed = (collapsed: boolean) => {
  try {
    window.localStorage.setItem(COLLAPSED_STORAGE_KEY, collapsed ? '1' : '0');
  } catch {
    // Not remembered - it still folds.
  }
};

type SidebarShellProps = {
  /** Desktop sidebar width in px. */
  width: number;
  /** Small uppercase caption next to the ProGeo brand (e.g. the portal title). */
  subtitle?: string;
  toggleLabel: string;
  closeLabel: string;
  /** Labels of the fold button (desktop). */
  collapseLabel: string;
  expandLabel: string;
  /**
   * The navigation - shown in the sidebar, or in the dropdown on mobile. A
   * function gets whether the desktop sidebar is folded (icons only).
   */
  children: ReactNode | ((state: { collapsed: boolean }) => ReactNode);
};

const Brand = ({
  subtitle,
  mobile,
}: {
  subtitle?: string;
  mobile: boolean;
}) => (
  <>
    <img
      src="/assets/progeo-logo.png"
      alt="ProGeo"
      className="progeo-sidebar-logo"
    />
    {subtitle && (
      <>
        <div className="progeo-sidebar-brand-divider" />
        <div
          className={`progeo-sidebar-subtitle progeo-sidebar-subtitle--${mobile ? 'mobile' : 'desktop'}`}
        >
          {subtitle}
        </div>
      </>
    )}
  </>
);

/**
 * Chrome of LocationSidebar (the app's sidebar): a fixed-width sidebar on
 * desktop - foldable to its icons (remembered per browser) - and a sticky
 * top bar with a burger dropdown below MOBILE_BREAKPOINT (closed again on
 * every route change).
 */
const SidebarShell = ({
  width,
  subtitle,
  toggleLabel,
  closeLabel,
  collapseLabel,
  expandLabel,
  children,
}: SidebarShellProps) => {
  const routerLocation = useRouterLocation();
  const [mobile, setMobile] = useState(
    typeof window !== 'undefined' && window.innerWidth < MOBILE_BREAKPOINT,
  );
  const [menuOpen, setMenuOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const content = (folded: boolean) => (typeof children === 'function' ? children({ collapsed: folded }) : children);
  const toggleCollapsed = () =>
    setCollapsed((current) => {
      storeCollapsed(!current);
      return !current;
    });

  useEffect(() => {
    const onResize = () => setMobile(window.innerWidth < MOBILE_BREAKPOINT);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    setMenuOpen(false);
  }, [routerLocation.pathname]);

  if (!mobile) {
    const foldLabel = collapsed ? expandLabel : collapseLabel;
    return (
      <aside
        data-collapsed={collapsed ? 'true' : 'false'}
        className="progeo-sidebar"
        data-testid="sidebar"
        style={{
          width: collapsed ? SIDEBAR_COLLAPSED_WIDTH : width,
          padding: collapsed ? '20px 8px 18px' : '20px 14px 18px 18px',
        }}
      >
        <div className="progeo-sidebar-head">
          {!collapsed && <Brand subtitle={subtitle} mobile={false} />}
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label={foldLabel}
            title={foldLabel}
            aria-expanded={!collapsed}
            className="progeo-sidebar-button progeo-sidebar-fold"
            data-testid="sidebar-fold"
          >
            {collapsed ? <ChevronDoubleRight size={15} /> : <ChevronDoubleLeft size={15} />}
          </button>
        </div>
        {content(collapsed)}
      </aside>
    );
  }

  return (
    <aside className="progeo-sidebar-bar" data-testid="sidebar">
      <div className="progeo-sidebar-bar-head">
        <Brand subtitle={subtitle} mobile />
        <button
          type="button"
          onClick={() => setMenuOpen((open) => !open)}
          aria-label={toggleLabel}
          aria-expanded={menuOpen}
          className="progeo-sidebar-button progeo-sidebar-burger"
          data-open={menuOpen ? 'true' : 'false'}
          data-testid="sidebar-burger"
        >
          {menuOpen ? <X size={20} /> : <List size={20} />}
        </button>
      </div>

      {menuOpen && (
        <>
          <button
            type="button"
            aria-label={closeLabel}
            onClick={() => setMenuOpen(false)}
            className="progeo-sidebar-backdrop"
            data-testid="sidebar-backdrop"
          />
          <div className="progeo-sidebar-menu" data-testid="sidebar-menu">
            {content(false)}
          </div>
        </>
      )}
    </aside>
  );
};

export default SidebarShell;
