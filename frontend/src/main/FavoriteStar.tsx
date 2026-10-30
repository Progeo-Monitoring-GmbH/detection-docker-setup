import { Star, StarFill } from 'react-bootstrap-icons';
import { useTranslation } from 'react-i18next';
import { useFavorites } from './favorites';

/** Gold of a favorite's star. */
export const FAVORITE_COLOR = '#F2B705';

/**
 * The big star that pins a location as favorite of the staff user (or
 * unpins it) - nothing for everyone else.
 */
const FavoriteStar = ({ locationId, size = 40 }: { locationId: number; size?: number }) => {
  const { t } = useTranslation();
  const { enabled, isFavorite, isPending, toggle } = useFavorites();
  if (!enabled || !locationId) {
    return null;
  }
  const favorite = isFavorite(locationId);
  const label = t(favorite ? 'favorites_remove' : 'favorites_add');
  const Icon = favorite ? StarFill : Star;
  return (
    <button
      type="button"
      data-testid="favorite-star"
      aria-pressed={favorite}
      aria-label={label}
      title={label}
      disabled={isPending(locationId)}
      onClick={(event) => {
        // In clickable rows: only the star.
        event.preventDefault();
        event.stopPropagation();
        toggle(locationId);
      }}
      style={{
        border: 'none',
        background: 'transparent',
        padding: 2,
        lineHeight: 0,
        cursor: 'pointer',
        color: favorite ? FAVORITE_COLOR : '#B8B0B0',
        transition: 'transform 120ms ease, color 120ms ease',
      }}
      onMouseEnter={(event) => {
        event.currentTarget.style.transform = 'scale(1.12)';
      }}
      onMouseLeave={(event) => {
        event.currentTarget.style.transform = 'none';
      }}
    >
      <Icon size={size} />
    </button>
  );
};

export default FavoriteStar;
