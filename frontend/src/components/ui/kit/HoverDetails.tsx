import { useEffect, useRef, useState, type ReactNode } from 'react';

/** Hover delay before unfolding (ms): a mouse passing by opens nothing. */
export const HOVER_OPEN_DELAY_MS = 150;

/**
 * A <details> that unfolds when the mouse rests on it and stays open after
 * it leaves - folding back on leave made a dialog of several of them flicker
 * while moving from one to the next. A click on the summary folds / unfolds
 * it; touch and keyboard work like a plain <details>.
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
  const [open, setOpen] = useState(false);
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
      open={open}
      data-testid={testId}
      onPointerEnter={(event) => {
        if (event.pointerType !== 'mouse') {
          return;
        }
        clearTimer();
        timer.current = setTimeout(() => setOpen(true), HOVER_OPEN_DELAY_MS);
      }}
      onPointerLeave={(event) => {
        // Only a mouse passing by: what is open stays open.
        if (event.pointerType === 'mouse') {
          clearTimer();
        }
      }}
    >
      <summary
        onClick={(event) => {
          // React owns `open` - the browser's own toggle would fight it.
          event.preventDefault();
          clearTimer();
          setOpen((current) => !current);
        }}
      >
        {summary}
      </summary>
      {children}
    </details>
  );
};

export default HoverDetails;
