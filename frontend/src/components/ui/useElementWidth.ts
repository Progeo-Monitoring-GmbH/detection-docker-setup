import { useLayoutEffect, useState, type DependencyList, type RefObject } from 'react';

/**
 * The element's clientWidth, followed with a ResizeObserver - `fallback`
 * until it is measured (and without ResizeObserver, e.g. in tests). `deps`:
 * when the element is mounted later (e.g. after loading), observe it anew.
 */
const useElementWidth = (
  ref: RefObject<HTMLElement | null>,
  fallback = 800,
  deps: DependencyList = [],
) => {
  const [width, setWidth] = useState(fallback);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    const observer = new ResizeObserver(() => setWidth(element.clientWidth || fallback));
    observer.observe(element);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return width;
};

export default useElementWidth;
