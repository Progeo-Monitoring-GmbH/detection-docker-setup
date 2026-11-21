/**
 * A DataTable sortFunction: numbers ascending, a missing value (null) after
 * every number - also when DataTable reverses the order for descending.
 */
export const byNumberNullsLast =
  <T,>(pick: (row: T) => number | null) =>
  (a: T, b: T) => {
    const left = pick(a);
    const right = pick(b);
    if (left == null || right == null) {
      return left == null && right == null ? 0 : left == null ? 1 : -1;
    }
    return left - right;
  };
