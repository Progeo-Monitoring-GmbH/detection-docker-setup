import { useEffect, useRef, type RefObject } from 'react';

/**
 * Moving through a page's items with the keyboard and, on touch screens,
 * with swipes - one set of actions for both (e.g. the screen review's
 * gallery). Arrow keys and letters (`keys`) work on the whole page, but not
 * while the user types, holds a modifier or a dialog is open.
 *
 *   useKeyNavigation({ left, right, up, down, keys: { r: toggleReviewed } }, enabled);
 *   useSwipeNavigation(galleryRef, (direction, target) => ...);
 */

export type Direction = 'left' | 'right' | 'up' | 'down';

export type NavigationHandlers = Partial<Record<Direction, () => void>> & {
  /** Further keys by their (lower-case) `event.key`, e.g. { r: ..., enter: ... }. */
  keys?: Record<string, () => void>;
};

const ARROWS: Record<string, Direction> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
};

/** Typing in a field, or a dialog over the page: the keys are not ours. */
const keysBelongElsewhere = (event: KeyboardEvent) => {
  if (event.ctrlKey || event.metaKey || event.altKey) {
    return true;
  }
  const target = event.target as HTMLElement | null;
  if (
    target?.closest?.(
      'input, textarea, select, [contenteditable="true"], [role="slider"]',
    )
  ) {
    return true;
  }
  return (
    typeof document !== 'undefined' &&
    document.querySelector('.modal.show') !== null
  );
};

/** The action a key press asks for: a direction, another key ("r", "enter") or null. */
export const keyAction = (event: KeyboardEvent): Direction | string | null => {
  if (keysBelongElsewhere(event)) {
    return null;
  }
  return (
    ARROWS[event.key] ??
    (event.key.length === 1 || event.key === 'Enter'
      ? event.key.toLowerCase()
      : null)
  );
};

/** Arrow keys (and `handlers.keys`) on the whole page while `enabled`. */
export const useKeyNavigation = (
  handlers: NavigationHandlers,
  enabled = true,
) => {
  // The latest handlers - the listener is registered once.
  const latest = useRef(handlers);
  useEffect(() => {
    latest.current = handlers;
  });
  useEffect(() => {
    if (!enabled) {
      return undefined;
    }
    const onKey = (event: KeyboardEvent) => {
      const action = keyAction(event);
      if (action == null) {
        return;
      }
      const current = latest.current;
      const handler =
        (action in ARROWS_BY_DIRECTION
          ? current[action as Direction]
          : undefined) ?? current.keys?.[action];
      if (handler) {
        event.preventDefault();
        handler();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
};

const ARROWS_BY_DIRECTION: Record<Direction, true> = {
  left: true,
  right: true,
  up: true,
  down: true,
};

/** A swipe's at least this long (px), and clearly more one way than the other. */
export const SWIPE_MIN = 50;

/**
 * Which way a finger moved by (dx, dy): the content follows it, so a swipe
 * to the left asks for what comes next on the right ("right"), a swipe up
 * for what comes below ("down"). null: too short or diagonal.
 */
export const swipeDirection = (
  dx: number,
  dy: number,
  min = SWIPE_MIN,
): Direction | null => {
  if (Math.abs(dx) >= min && Math.abs(dx) > Math.abs(dy) * 1.5) {
    return dx < 0 ? 'right' : 'left';
  }
  if (Math.abs(dy) >= min && Math.abs(dy) > Math.abs(dx) * 1.5) {
    return dy < 0 ? 'down' : 'up';
  }
  return null;
};

/**
 * Swipes on `ref`'s element (touch and pen only - a mouse drag is no swipe):
 * `onSwipe(direction, target)`, `target` the element the finger started on.
 * Vertical swipes stay the page's scrolling where the element allows it
 * (touch-action: pan-y) - the browser takes them over before they end here.
 */
export const useSwipeNavigation = (
  ref: RefObject<HTMLElement | null>,
  onSwipe: (direction: Direction, target: Element | null) => void,
  enabled = true,
) => {
  const latest = useRef(onSwipe);
  useEffect(() => {
    latest.current = onSwipe;
  });
  useEffect(() => {
    const element = ref.current;
    if (!element || !enabled) {
      return undefined;
    }
    let start: {
      x: number;
      y: number;
      target: Element | null;
      id: number;
    } | null = null;
    const down = (event: PointerEvent) => {
      if (event.pointerType === 'mouse' || !event.isPrimary) {
        return;
      }
      start = {
        x: event.clientX,
        y: event.clientY,
        target: event.target as Element | null,
        id: event.pointerId,
      };
    };
    const up = (event: PointerEvent) => {
      if (!start || event.pointerId !== start.id) {
        return;
      }
      const direction = swipeDirection(
        event.clientX - start.x,
        event.clientY - start.y,
      );
      const target = start.target;
      start = null;
      if (direction) {
        latest.current(direction, target);
      }
    };
    const cancel = () => {
      start = null;
    };
    element.addEventListener('pointerdown', down);
    element.addEventListener('pointerup', up);
    element.addEventListener('pointercancel', cancel);
    return () => {
      element.removeEventListener('pointerdown', down);
      element.removeEventListener('pointerup', up);
      element.removeEventListener('pointercancel', cancel);
    };
  }, [ref, enabled]);
};
