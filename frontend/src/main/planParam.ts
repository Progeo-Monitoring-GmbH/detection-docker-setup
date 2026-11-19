/**
 * ?plan=<lageplan id>: the plan a location page opens with - the group bar
 * of a merged project (LocationGroupBar) switches between the plans of its
 * parts with it. Picking another plan on the page wins until the URL changes.
 */
export const PLAN_PARAM = 'plan';

/** The plan of the URL, or null. */
export const planFromParams = (params: URLSearchParams): number | null => {
  const value = Number(params.get(PLAN_PARAM));
  return Number.isInteger(value) && value > 0 ? value : null;
};
