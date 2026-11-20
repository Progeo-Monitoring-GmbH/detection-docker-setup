import { useEffect, useRef, useState, type ReactNode } from 'react';

/** Hover delay before unfolding (ms): a mouse passing by opens nothing. */
export const HOVER_OPEN_DELAY_MS = 150;

/**
 * A <details> that unfolds while the mouse is over it and folds again when
 * it leaves. A click on the summary keeps it open, a second one closes it;
 * touch and keyboard work like a plain <details>.
 */
const HoverDetails = ({
  summary,
  children,
  className,
  testId,
}: {
  summary: ReactNode;
  children: ReactNode;
  className?: string;
  testId?: string;
}) => {
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = () => {
    if (timer.current != null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };
  useEffect(() => clearTimer, []);

  return (
    <details
      className={className}
      open={pinned || hovered}
      data-testid={testId}
      onPointerEnter={(event) => {
        if (event.pointerType !== 'mouse') {
          return;
        }
        clearTimer();
        timer.current = setTimeout(() => setHovered(true), HOVER_OPEN_DELAY_MS);
      }}
      onPointerLeave={(event) => {
        if (event.pointerType !== 'mouse') {
          return;
        }
        clearTimer();
        setHovered(false);
      }}
    >
      <summary
        onClick={(event) => {
          // React owns `open` - the browser's own toggle would fight it.
          event.preventDefault();
          clearTimer();
          // Opened by hovering, the click keeps it open; open by a click,
          // it closes - until the mouse comes back.
          if (pinned) {
            setPinned(false);
            setHovered(false);
          } else {
            setPinned(true);
          }
        }}
      >
        {summary}
      </summary>
      {children}
    </details>
  );
};

export default HoverDetails;
