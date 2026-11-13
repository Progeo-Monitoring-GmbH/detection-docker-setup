import { StarFill, XLg } from 'react-bootstrap-icons';
import { useTranslation } from 'react-i18next';
import { Link, useLocation as useRouterLocation } from 'react-router';
import { FAVORITE_COLOR } from './FavoriteStar';
import { repeatedTestId } from '../testIds';
import { useFavorites } from './favorites';
import { switchLocationPath } from './portalNav';
import './Favorites.css';

/**
 * The user's favorite locations as one bar at the top of every page
 * (below the TopBar): each one opens the location on the tab of the open
 * location page (/objekt stays /objekt), elsewhere its analysis; the x next
 * to it removes the favorite. Hidden without favorites - the stars pin them.
 */
const FavoritesBar = ({ className }: { className?: string }) => {
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
      className={className ? `favorites-bar ${className}` : 'favorites-bar'}
    >
      <span
        className="d-inline-flex align-items-center gap-1 favorites-bar-title"
        data-testid="favorites-bar-title"
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
            {...repeatedTestId('favorites-bar-item', favorite.location)}
            className={`d-inline-flex align-items-center favorites-bar-pill${active ? ' favorites-bar-pill--active' : ''}`}
          >
            <Link
              to={switchLocationPath(pathname, favorite.location)}
              title={[favorite.project_id, favorite.name, favorite.city].filter(Boolean).join(' · ')}
              className="favorites-bar-link"
              {...repeatedTestId('favorites-bar-link', favorite.location)}
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
              className="favorites-bar-remove"
              {...repeatedTestId('favorites-bar-remove', favorite.location)}
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
