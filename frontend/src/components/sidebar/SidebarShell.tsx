import { useEffect, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { useLocation as useRouterLocation } from 'react-router';
import { List, X } from 'react-bootstrap-icons';

const MOBILE_BREAKPOINT = 860;

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

/** Common look of a sidebar nav link; callers add colors/active state. */
export const sidebarItemBaseStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  width: '100%',
  textAlign: 'left',
  whiteSpace: 'nowrap',
  padding: '11px 14px',
  border: 'none',
  borderRadius: 13,
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: 14,
  fontWeight: 500,
};

export const SIDEBAR_ACTIVE_SHADOW = '0 3px 12px rgba(11, 54, 89, .1)';

type SidebarShellProps = {
  /** Desktop sidebar width in px. */
  width: number;
  /** Small uppercase caption next to the ProGeo brand (e.g. the portal title). */
  subtitle?: string;
  toggleLabel: string;
  closeLabel: string;
  /** The navigation - shown in the sidebar, or in the dropdown on mobile. */
  children: ReactNode;
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
 * Chrome shared by AppSidebar and LocationSidebar: a fixed-width sidebar on
 * desktop, and a sticky top bar with a burger dropdown below
 * MOBILE_BREAKPOINT (closed again on every route change).
 */
const SidebarShell = ({
  width,
  subtitle,
  toggleLabel,
  closeLabel,
  children,
}: SidebarShellProps) => {
  const routerLocation = useRouterLocation();
  const [mobile, setMobile] = useState(
    typeof window !== 'undefined' && window.innerWidth < MOBILE_BREAKPOINT,
  );
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const onResize = () => setMobile(window.innerWidth < MOBILE_BREAKPOINT);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    setMenuOpen(false);
  }, [routerLocation.pathname]);

  if (!mobile) {
    return (
      <aside
        style={{
          width,
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          padding: '20px 14px 18px 18px',
          gap: 22,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
          <Brand subtitle={subtitle} mobile={false} />
        </div>
        {children}
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
          style={{
            marginLeft: 'auto',
            width: 40,
            height: 40,
            flexShrink: 0,
            border: 'none',
            borderRadius: 12,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--progeo-blue)',
            background: menuOpen ? 'var(--progeo-surface)' : 'transparent',
            boxShadow: menuOpen ? '0 2px 10px rgba(11, 54, 89, .12)' : 'none',
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
            {children}
          </div>
        </>
      )}
    </aside>
  );
};

export default SidebarShell;
