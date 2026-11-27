import { useLayoutEffect, useRef } from 'react';

/**
 * A ref holding the value of the last render - for listeners and effects that
 * call the newest handler without subscribing again. Set right after the
 * render (layout effect: before any event or passive effect can read it),
 * never during it - writing a ref while rendering breaks React's rules
 * (oxlint react(refs)).
 */
export const useLatestRef = <T>(value: T) => {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
};
