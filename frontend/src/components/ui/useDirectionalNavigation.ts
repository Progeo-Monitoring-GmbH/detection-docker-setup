import { useEffect, type RefObject } from 'react';
import { useLatestRef } from './useLatestRef';

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

/**
 * Typing in a field, or a dialog over the page: the keys are not ours.
 * `inDialog`: the handlers belong to a dialog themselves - only a further
 * dialog over it (e.g. a confirmation) takes the keys.
 */
const keysBelongElsewhere = (event: KeyboardEvent, inDialog: boolean) => {
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
    document.querySelectorAll('.modal.show').length > (inDialog ? 1 : 0)
  );
};

/** The action a key press asks for: a direction, another key ("r", "enter") or null. */
export const keyAction = (
  event: KeyboardEvent,
  inDialog = false,
): Direction | string | null => {
  if (keysBelongElsewhere(event, inDialog)) {
    return null;
  }
  return (
    ARROWS[event.key] ??
    (event.key.length === 1 || event.key === 'Enter'
      ? event.key.toLowerCase()
      : null)
  );
};

/**
 * Arrow keys (and `handlers.keys`) on the whole page while `enabled`;
 * `inDialog`: for a dialog's own navigation (see keysBelongElsewhere).
 */
export const useKeyNavigation = (
  handlers: NavigationHandlers,
  enabled = true,
  { inDialog = false }: { inDialog?: boolean } = {},
) => {
  // The latest handlers - the listener is registered once.
  const latest = useLatestRef(handlers);
  useEffect(() => {
    if (!enabled) {
      return undefined;
    }
    const onKey = (event: KeyboardEvent) => {
      const action = keyAction(event, inDialog);
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
  }, [enabled, inDialog, latest]);
};

const ARROWS_BY_DIRECTION: Record<Direction, true> = {
  left: true,
  right: true,
  up: true,
  down: true,
};

/** A swipe's at least this long (px), and clearly more one way than the other. */
const SWIPE_MIN = 50;

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
  const latest = useLatestRef(onSwipe);
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
  }, [ref, enabled, latest]);
};

/**
 * Where an element stands scrolled - within its range: Safari's rubber band
 * at an end reports positions beyond it for a moment, that is no scrolling.
 */
const scrolledX = (node: Element) =>
  Math.min(Math.max(node.scrollLeft, 0), node.scrollWidth - node.clientWidth);
const scrolledY = (node: Element) =>
  Math.min(Math.max(node.scrollTop, 0), node.scrollHeight - node.clientHeight);

/** Where an element and its ancestors (up to `root`) stand scrolled. */
const scrollPositions = (from: Element | null, root: Element) => {
  const positions: [Element, number, number][] = [];
  for (let node = from; node; node = node.parentElement) {
    positions.push([node, scrolledX(node), scrolledY(node)]);
    if (node === root) {
      break;
    }
  }
  return positions;
};

/**
 * Swipes of one finger on `element` through touch events - unlike pointer
 * events they still end here when the browser scrolled with the finger.
 * `onSwipe(direction, { target, scrolled })`: `scrolled` - something under
 * the finger (up to `element`) scrolled that way, e.g. a strip of parts
 * not yet at its end; a swipe at the end is a step on (like a photo pager).
 */
export const useTouchSwipe = (
  element: HTMLElement | null,
  onSwipe: (
    direction: Direction,
    swipe: { target: Element | null; scrolled: boolean },
  ) => void,
  enabled = true,
) => {
  const latest = useLatestRef(onSwipe);
  useEffect(() => {
    if (!element || !enabled) {
      return undefined;
    }
    let start: {
      x: number;
      y: number;
      target: Element | null;
      positions: [Element, number, number][];
    } | null = null;
    const begin = (event: TouchEvent) => {
      // A second finger (pinch) is no swipe.
      if (event.touches.length !== 1) {
        start = null;
        return;
      }
      const touch = event.touches[0];
      const target = event.target as Element | null;
      start = {
        x: touch.clientX,
        y: touch.clientY,
        target,
        positions: scrollPositions(target, element),
      };
    };
    const end = (event: TouchEvent) => {
      const touch = event.changedTouches[0];
      if (!start || !touch || event.touches.length > 0) {
        start = null;
        return;
      }
      const direction = swipeDirection(
        touch.clientX - start.x,
        touch.clientY - start.y,
      );
      const { target, positions } = start;
      start = null;
      if (!direction) {
        return;
      }
      const horizontal = direction === 'left' || direction === 'right';
      const scrolled = positions.some(([node, left, top]) =>
        horizontal
          ? Math.abs(scrolledX(node) - left) > 1
          : Math.abs(scrolledY(node) - top) > 1,
      );
      latest.current(direction, { target, scrolled });
    };
    const cancel = () => {
      start = null;
    };
    element.addEventListener('touchstart', begin, { passive: true });
    element.addEventListener('touchend', end);
    element.addEventListener('touchcancel', cancel);
    return () => {
      element.removeEventListener('touchstart', begin);
      element.removeEventListener('touchend', end);
      element.removeEventListener('touchcancel', cancel);
    };
  }, [element, enabled, latest]);
};
