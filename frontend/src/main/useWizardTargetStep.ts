import { useEffect, useState } from 'react';
import { useLocation as useRouterLocation } from 'react-router';

/** What ends the scrolling to the step: the user scrolling themselves. */
const USER_SCROLL_EVENTS = [
  'wheel',
  'touchstart',
  'keydown',
  'mousedown',
] as const;
/** When to scroll there again - while plans and points load and push it down. */
const SCROLL_DELAYS = [0, 600, 1500];

/**
 * The step the wizard was opened at (#wizard-..., e.g. from the checklist's
 * "Beheben"): scrolled to once the location is chosen - again while its
 * plans and points load and push the step down, until the user scrolls
 * themselves. The step is kept apart from the URL: the browser marked no
 * :target (the step wasn't rendered yet), and nothing that rewrites the URL
 * may lose it.
 */
export const useWizardTargetStep = (selectedLocationId: number | null) => {
  const { hash } = useRouterLocation();
  const [targetStep, setTargetStep] = useState<string | null>(
    () => hash.slice(1) || null,
  );
  // A new #step is taken over while rendering (no effect needed).
  const [prevHash, setPrevHash] = useState(hash);
  if (hash !== prevHash) {
    setPrevHash(hash);
    if (hash.length > 1) {
      setTargetStep(hash.slice(1));
    }
  }
  useEffect(() => {
    const target = targetStep;
    if (!target || selectedLocationId === null) {
      return undefined;
    }
    let stopped = false;
    const stop = () => {
      stopped = true;
    };
    const scroll = () => {
      if (!stopped) {
        document
          .getElementById(target)
          ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    };
    const timers = SCROLL_DELAYS.map((delay) =>
      window.setTimeout(scroll, delay),
    );
    USER_SCROLL_EVENTS.forEach((event) =>
      window.addEventListener(event, stop, { passive: true }),
    );
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      USER_SCROLL_EVENTS.forEach((event) =>
        window.removeEventListener(event, stop),
      );
    };
  }, [targetStep, selectedLocationId]);
  return targetStep;
};
