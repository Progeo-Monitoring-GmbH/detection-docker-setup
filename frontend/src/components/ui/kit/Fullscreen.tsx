import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ArrowsFullscreen, FullscreenExit } from 'react-bootstrap-icons';
import { useTranslation } from 'react-i18next';
import './Fullscreen.css';

const nativeSupported = () =>
  typeof document !== 'undefined' &&
  Boolean(
    document.fullscreenEnabled && document.documentElement.requestFullscreen,
  );

/**
 * A panel the user can show on the whole screen - a plan or heatmap on a
 * phone gets the full width (and the height, in landscape) instead of a strip.
 * The browser's fullscreen where it has one; else (iPhone Safari allows it for
 * videos only) the panel covers the page (FullscreenFrame's fallback class).
 * Escape (or the browser's own gesture) leaves it.
 */
export const useFullscreen = () => {
  // A callback ref (setElement): the frame's element as state.
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [active, setActive] = useState(false);
  const [fallback, setFallback] = useState(false);

  useEffect(() => {
    const onChange = () =>
      setActive(element !== null && document.fullscreenElement === element);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, [element]);

  // The covering fallback: Escape leaves it, the page doesn't scroll behind it.
  useEffect(() => {
    if (!fallback) {
      return undefined;
    }
    const onKey = (event: KeyboardEvent) =>
      event.key === 'Escape' && setFallback(false);
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
    };
  }, [fallback]);

  const toggle = useCallback(() => {
    if (!element) {
      return;
    }
    if (nativeSupported()) {
      if (document.fullscreenElement) {
        void document.exitFullscreen();
      } else {
        element.requestFullscreen().catch(() => setFallback(true));
      }
      return;
    }
    setFallback((on) => !on);
  }, [element]);

  return { setElement, active: active || fallback, fallback, toggle };
};

type FullscreenState = ReturnType<typeof useFullscreen>;

/** The element shown full screen - around the panel, its header (with the button) included. */
export const FullscreenFrame = ({
  state: { setElement, fallback, active },
  children,
}: {
  state: FullscreenState;
  children: ReactNode;
}) => (
  <div
    ref={setElement}
    className={`progeo-fullscreen${fallback ? ' progeo-fullscreen--fallback' : ''}${active ? ' progeo-fullscreen--active' : ''}`}
  >
    {children}
  </div>
);

/** The round button for a panel's header: on to the whole screen and back. */
export const FullscreenButton = ({
  state,
  testId,
}: {
  state: FullscreenState;
  testId?: string;
}) => {
  const { t } = useTranslation();
  const label = state.active ? t('ui_fullscreen_exit') : t('ui_fullscreen');
  return (
    <button
      type="button"
      className="progeo-fullscreen-button"
      onClick={state.toggle}
      title={label}
      aria-label={label}
      aria-pressed={state.active}
      data-testid={testId}
    >
      {state.active ? (
        <FullscreenExit size={14} />
      ) : (
        <ArrowsFullscreen size={13} />
      )}
    </button>
  );
};
