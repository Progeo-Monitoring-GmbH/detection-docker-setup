import type { CSSProperties } from 'react';
import { StarFill, XLg } from 'react-bootstrap-icons';
import { useTranslation } from 'react-i18next';
import { Link, useLocation as useRouterLocation } from 'react-router';
import { FAVORITE_COLOR } from './FavoriteStar';
import { useFavorites } from './favorites';

/**
 * The staff user's favorite locations as one bar at the top of every page
 * (below the TopBar): each one opens the location's status, the x next to
 * it removes the favorite. Hidden without favorites - the stars pin them.
 */
const FavoritesBar = ({ style }: { style?: CSSProperties }) => {
  const { t } = useTranslation();
  const { enabled, favorites, max, isPending, toggle } = useFavorites();
  const { pathname } = useRouterLocation();
  if (!enabled || favorites.length === 0) {
    return null;
  }
  const openId = Number(/^\/location\/(\d+)\//.exec(pathname)?.[1] ?? Number.NaN);

  return (
    <nav
      aria-label={t('favorites_title')}
      data-testid="favorites-bar"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
        padding: '8px 12px',
        background: 'var(--progeo-panel-bg)',
        borderRadius: 'var(--progeo-radius-panel)',
        boxShadow: 'var(--progeo-shadow-panel)',
        ...style,
      }}
    >
      <span
        className="d-inline-flex align-items-center gap-1"
        style={{ fontSize: 12, fontWeight: 600, color: '#8B8383', marginRight: 4 }}
        title={t('favorites_count', { count: favorites.length, max })}
      >
        <StarFill size={16} color={FAVORITE_COLOR} />
        {t('favorites_title')}
      </span>
      {favorites.map((favorite) => {
        const active = favorite.location === openId;
        const name = favorite.name || t('favorites_unnamed');
        return (
          <span
            key={favorite.location}
            className="d-inline-flex align-items-center"
            style={{
              borderRadius: 'var(--progeo-radius-pill)',
              background: active ? 'var(--progeo-blue)' : 'var(--progeo-surface)',
              color: active ? '#ffffff' : 'var(--progeo-blue)',
              fontSize: 13,
              fontWeight: 500,
              maxWidth: 260,
            }}
          >
            <Link
              to={`/location/${favorite.location}/status`}
              title={[favorite.project_id, favorite.name, favorite.city].filter(Boolean).join(' · ')}
              style={{
                color: 'inherit',
                textDecoration: 'none',
                padding: '5px 4px 5px 12px',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {favorite.project_id != null && <strong className="me-1">{favorite.project_id}</strong>}
              {name}
            </Link>
            <button
              type="button"
              aria-label={t('favorites_remove_named', { name })}
              title={t('favorites_remove')}
              disabled={isPending(favorite.location)}
              onClick={() => toggle(favorite.location)}
              style={{
                border: 'none',
                background: 'transparent',
                color: 'inherit',
                opacity: 0.7,
                padding: '5px 10px 5px 6px',
                lineHeight: 0,
                cursor: 'pointer',
              }}
            >
              <XLg size={12} />
            </button>
          </span>
        );
      })}
    </nav>
  );
};

export default FavoritesBar;
