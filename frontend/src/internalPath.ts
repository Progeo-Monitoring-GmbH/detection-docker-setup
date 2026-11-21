/**
 * `value` if it is a path of this site ("/location/1/status"), else null -
 * never another origin: no "//host" or "/\host" (browsers read both as a
 * protocol-relative URL), no "https:" or "javascript:". For the redirect
 * after a login and for links that come from an API answer.
 */
export const internalPath = (value: unknown): string | null => {
  const path = typeof value === 'string' ? value : '';
  return path.startsWith('/') && !path.startsWith('//') && !path.startsWith('/\\') ? path : null;
};
