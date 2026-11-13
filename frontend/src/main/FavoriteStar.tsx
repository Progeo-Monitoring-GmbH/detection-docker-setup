import { Star, StarFill } from 'react-bootstrap-icons';
import { useTranslation } from 'react-i18next';
import { repeatedTestId } from '../testIds';
import { useFavorites } from './favorites';
import './Favorites.css';

/** Gold of a favorite's star (also .favorite-star--active in Favorites.css). */
export const FAVORITE_COLOR = '#F2B705';

/**
 * The big star that pins a location as favorite of the user (or unpins it).
 * Its test id carries the location as data-test-key (one star per table row).
 */
const FavoriteStar = ({
  locationId,
  size = 40,
  testId = 'favorite-star',
}: {
  locationId: number;
  size?: number;
  /** data-testid of the button (src/testIds.ts). */
  testId?: string;
}) => {
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
      {...repeatedTestId(testId, locationId)}
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
      className={`favorite-star${favorite ? ' favorite-star--active' : ''}`}
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
