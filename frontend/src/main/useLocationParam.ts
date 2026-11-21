import { useSearchParams } from 'react-router';

/**
 * The location chosen in a page's picker, kept in `?location=<id>` (a link
 * or reload opens the same one): `locationId` (null without a valid one)
 * and `selectLocation` (null clears it; replaces the history entry).
 */
const useLocationParam = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const param = Number(searchParams.get('location'));
  const locationId = Number.isInteger(param) && param > 0 ? param : null;

  const selectLocation = (location: { id?: number | null } | null) => {
    const next = new URLSearchParams(searchParams);
    if (location?.id != null) {
      next.set('location', String(location.id));
    } else {
      next.delete('location');
    }
    setSearchParams(next, { replace: true });
  };

  return { locationId, selectLocation };
};

export default useLocationParam;
