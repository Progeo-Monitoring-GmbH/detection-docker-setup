/** Absolute URL of a backend path (media files etc.); absolute URLs pass through. */
export const getBackendUrl = (path: string) => {
  if (/^https?:\/\//i.test(path)) {
    return path;
  }
  const backendUrl = import.meta.env.VITE_BACKEND_URL || window.location.origin;
  return `${backendUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
};
