import { useEffect, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { useLocation as useRouterLocation } from 'react-router';
import { ChevronDoubleLeft, ChevronDoubleRight, List, X } from 'react-bootstrap-icons';
// The look of the nav links (.progeo-sidebar-item) and of these buttons.
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

/** Uppercase section caption; `separated` adds the divider above a group. */
export const sidebarGroupLabelStyle = (separated: boolean): CSSProperties => ({
  fontSize: 10,
  letterSpacing: '.12em',
  textTransform: 'uppercase',
  color: '#A09898',
  fontWeight: 600,
  padding: separated ? '16px 14px 7px' : '2px 14px 7px',
  ...(separated ? { marginTop: 8, borderTop: '1px solid #D9D4D4' } : {}),
});

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
      style={{ height: 20, width: 'auto', flexShrink: 0, display: 'block' }}
    />
    {subtitle && (
      <>
        <div
          style={{ width: 1, height: 22, background: '#D0CACA', flexShrink: 0 }}
        />
        <div
          style={{
            fontSize: 10,
            letterSpacing: '.12em',
            textTransform: 'uppercase',
            color: '#6E6868',
            fontWeight: 500,
            ...(mobile ? { whiteSpace: 'nowrap' } : { lineHeight: 1.3 }),
          }}
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
        style={{
          width: collapsed ? SIDEBAR_COLLAPSED_WIDTH : width,
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          padding: collapsed ? '20px 8px 18px' : '20px 14px 18px 18px',
          gap: 22,
          transition: 'width .18s ease, padding .18s ease',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: collapsed ? 'center' : 'flex-start',
            gap: 11,
          }}
        >
          {!collapsed && <Brand subtitle={subtitle} mobile={false} />}
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label={foldLabel}
            title={foldLabel}
            aria-expanded={!collapsed}
            className="progeo-sidebar-button"
            style={{
              marginLeft: collapsed ? 0 : 'auto',
              width: 32,
              height: 32,
              borderRadius: 10,
            }}
          >
            {collapsed ? <ChevronDoubleRight size={15} /> : <ChevronDoubleLeft size={15} />}
          </button>
        </div>
        {content(collapsed)}
      </aside>
    );
  }

  return (
    <aside
      style={{
        width: '100%',
        display: 'flex',
        flexDirection: 'column',
        padding: '11px 12px',
        position: 'sticky',
        top: 0,
        zIndex: 60,
        background: 'var(--progeo-page-bg)',
        boxShadow: '0 8px 18px -14px rgba(11, 54, 89, .3)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
        <Brand subtitle={subtitle} mobile />
        <button
          type="button"
          onClick={() => setMenuOpen((open) => !open)}
          aria-label={toggleLabel}
          aria-expanded={menuOpen}
          className="progeo-sidebar-button"
          data-open={menuOpen ? 'true' : 'false'}
          style={{
            marginLeft: 'auto',
            width: 40,
            height: 40,
            borderRadius: 12,
          }}
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
            style={{
              position: 'fixed',
              inset: 0,
              background: 'rgba(11, 54, 89, .28)',
              zIndex: 55,
              border: 'none',
              padding: 0,
            }}
          />
          <div
            className="progeo-sidebar-menu"
            style={{
              position: 'absolute',
              top: '100%',
              left: 0,
              right: 0,
              background: 'var(--progeo-surface)',
              padding: '8px 10px 14px',
              borderRadius: '0 0 18px 18px',
              boxShadow: '0 22px 44px rgba(11, 54, 89, .22)',
              maxHeight: 'calc(100vh - 70px)',
              overflow: 'auto',
              zIndex: 62,
            }}
          >
            {content(false)}
          </div>
        </>
      )}
    </aside>
  );
};

export default SidebarShell;
