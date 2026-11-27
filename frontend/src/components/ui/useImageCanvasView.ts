/**
 * Hooks of the plan canvas (ImageCanvasStage) for what is shown and the
 * input around it: loading the plan image, the canvas' shown width, pan and
 * zoom (Ctrl + wheel only, F fits), the window's mouse and the held keys, and
 * drawing the canvas.
 */
import { useEffect, useRef, useState, type RefObject } from 'react';
import axiosConfig from '../../axiosConfig';
import type { AuthContextType } from '../../../hooks/CoreAuthProvider';
import { drawStage, type StageScene } from './drawImageCanvas';
import {
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  clientToCanvas,
  keptInView,
  pixelRatioFor,
  wheelZoomFactor,
  zoomedView,
  type ImagePoint,
  type PlanImage,
  type PlanView,
} from './imageCanvasGeometry';
import { EDIT_KEYS, HELD_KEYS, VIEW_KEYS, type HeldKey, type ImageEdit } from './imageCanvasModes';
import { useLatestRef } from './useLatestRef';
import { isZoomWheel, useWheelHint } from './wheelZoom';

/** The plan image: local previews (blob:/data:) load directly; backend media
 * requires the Authorization header, which a plain <img> request can't send. */
export const usePlanImage = (auth: AuthContextType, imageUrl: string | undefined) => {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [imageError, setImageError] = useState('');
  // Another URL: nothing shown until it loaded - reset while rendering, not in the effect.
  const [shownUrl, setShownUrl] = useState(imageUrl);
  if (imageUrl !== shownUrl) {
    setShownUrl(imageUrl);
    setImage(null);
    setImageError('');
  }
  useEffect(() => {
    if (!imageUrl) {
      return undefined;
    }

    let cancelled = false;
    let objectUrl: string | null = null;
    const loadImage = (src: string) => {
      const nextImage = new Image();
      nextImage.onload = () => {
        if (!cancelled) {
          // Image and error replace each other (a reload with a new auth keeps the old until then).
          setImage(nextImage);
          setImageError('');
        }
      };
      nextImage.onerror = () => {
        if (!cancelled) {
          setImage(null);
          setImageError('The Lageplan image could not be displayed.');
        }
      };
      nextImage.src = src;
    };

    if (/^(blob|data):/i.test(imageUrl)) {
      loadImage(imageUrl);
    } else {
      void axiosConfig.perform_get(
        auth,
        imageUrl,
        (response) => {
          if (cancelled) {
            return;
          }
          objectUrl = URL.createObjectURL(response.data as Blob);
          loadImage(objectUrl);
        },
        (loadError) => {
          if (!cancelled) {
            setImage(null);
            setImageError(`Could not load the Lageplan image: ${(loadError as Error).message}`);
          }
        },
        { responseType: 'blob' },
      );
    }

    return () => {
      cancelled = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [auth, imageUrl]);
  return { image, setImage, imageError };
};

/** Shown width of the canvas (CSS pixels): it is drawn at that size times
 * the device pixel ratio; sizes of markers and labels are screen pixels. */
const useShownWidth = (canvasRef: RefObject<HTMLCanvasElement | null>) => {
  const [cssWidth, setCssWidth] = useState(CANVAS_WIDTH);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0) {
        setCssWidth(entry.contentRect.width);
      }
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [canvasRef]);
  return cssWidth;
};

/** The canvas on screen: its shown width and height (CSS pixels), screen
 * pixels per canvas unit (screenScale) and back (px), and the backing
 * store's pixels per canvas unit (pixelRatio) - sharp at any width. */
export const useScreenScale = (canvasRef: RefObject<HTMLCanvasElement | null>, canvasWidth: number) => {
  const cssWidth = useShownWidth(canvasRef);
  const screenScale = cssWidth / canvasWidth;
  return {
    cssWidth,
    cssHeight: (cssWidth * CANVAS_HEIGHT) / canvasWidth,
    screenScale,
    px: 1 / screenScale,
    pixelRatio: pixelRatioFor(screenScale, typeof window !== 'undefined' ? window.devicePixelRatio : 1),
  };
};

const HOME_VIEW: PlanView = { zoom: 1, offsetX: 0, offsetY: 0 };
const FIT_MS = 260;

const reducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

/** The view between `from` (t = 0) and `to` (t = 1): the zoom changes evenly
 * (log scale), the plan point in the middle of the canvas moves straight. */
const viewBetween = (from: PlanView, to: PlanView, t: number): PlanView => {
  const zoom = Math.exp(Math.log(from.zoom) + (Math.log(to.zoom) - Math.log(from.zoom)) * t);
  // The offset over the zoom is the plan point in the middle (up to the scale).
  const centerX = from.offsetX / from.zoom + (to.offsetX / to.zoom - from.offsetX / from.zoom) * t;
  const centerY = from.offsetY / from.zoom + (to.offsetY / to.zoom - from.offsetY / from.zoom) * t;
  return { zoom, offsetX: centerX * zoom, offsetY: centerY * zoom };
};

/**
 * Pan and zoom of the plan. Every change starts from the latest view (a ref),
 * not the one of the last render - wheel and touchpad send several events a
 * frame, each counts. Panning is shown once a frame (panTo, flushed by
 * endPan); some of the plan always stays in the canvas (keptInView).
 */
export const usePlanView = (logical: { width: number; height: number }, image: PlanImage | null) => {
  const [view, setViewState] = useState<PlanView>(HOME_VIEW);
  const viewRef = useRef(view);
  const frame = useRef<number | null>(null);
  const animation = useRef<number | null>(null);
  const bounds = useLatestRef({ logical, image });

  const cancelFrame = () => {
    if (frame.current != null) {
      cancelAnimationFrame(frame.current);
      frame.current = null;
    }
  };
  const stopAnimation = () => {
    if (animation.current != null) {
      cancelAnimationFrame(animation.current);
      animation.current = null;
    }
  };
  useEffect(
    () => () => {
      cancelFrame();
      stopAnimation();
    },
    [],
  );

  const kept = (next: PlanView) => keptInView(next, bounds.current.logical, bounds.current.image);
  /** Shown at once. */
  const commit = (next: PlanView) => {
    cancelFrame();
    viewRef.current = kept(next);
    setViewState(viewRef.current);
  };
  /** Shown with the next frame - several moves of one frame render once. */
  const commitNextFrame = (next: PlanView) => {
    viewRef.current = kept(next);
    if (typeof requestAnimationFrame !== 'function') {
      setViewState(viewRef.current);
    } else if (frame.current == null) {
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        setViewState(viewRef.current);
      });
    }
  };

  return {
    view,
    /** Zoom by `factor` around a canvas point (default: the middle). */
    zoomAround: (factor: number, at?: ImagePoint) => {
      stopAnimation();
      commit(zoomedView(viewRef.current, factor, bounds.current.logical.width, at));
    },
    resetView: () => {
      stopAnimation();
      commit(HOME_VIEW);
    },
    /** The pan (canvas units) - shown with the next frame. */
    panTo: (x: number, y: number) => {
      stopAnimation();
      commitNextFrame({ ...viewRef.current, offsetX: x, offsetY: y });
    },
    /** A pan ends: its last move is shown now. */
    endPan: () => {
      if (frame.current != null) {
        commit(viewRef.current);
      }
    },
    /** Glides to `target` (F) - at once without animation frames or with reduced motion. */
    glideTo: (target: PlanView) => {
      stopAnimation();
      const to = kept(target);
      if (typeof requestAnimationFrame !== 'function' || reducedMotion()) {
        commit(to);
        return;
      }
      const from = viewRef.current;
      const started = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - started) / FIT_MS);
        // Ease out: fast at first, settling on the target.
        commit(t >= 1 ? to : viewBetween(from, to, 1 - (1 - t) ** 3));
        animation.current = t >= 1 ? null : requestAnimationFrame(step);
      };
      animation.current = requestAnimationFrame(step);
    },
  };
};

/** Ctrl (or ⌘) + wheel zooms (isZoomWheel); the plain wheel scrolls the
 * page and only shows how to zoom - true while that hint shows. Native
 * listener: React's wheel handler is passive and can't keep the page from
 * scrolling. */
export const useCanvasWheelZoom = (
  canvasRef: RefObject<HTMLCanvasElement | null>,
  zoomAround: (factor: number, at: ImagePoint) => void,
) => {
  const zoomAroundRef = useLatestRef(zoomAround);
  const [wheelHint, showWheelHint] = useWheelHint();
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return undefined;
    }
    const onWheel = (event: WheelEvent) => {
      if (!isZoomWheel(event)) {
        showWheelHint();
        return;
      }
      event.preventDefault();
      const at = clientToCanvas(event, canvas.getBoundingClientRect());
      if (at) {
        zoomAroundRef.current(wheelZoomFactor(event), at);
      }
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [canvasRef, showWheelHint, zoomAroundRef]);
  return wheelHint;
};

/** The mouse anywhere on the page (a drag goes on off the canvas) - the
 * handlers of the last render are called. */
export const useWindowPointer = (onMove: (event: MouseEvent) => void, onUp: () => void) => {
  const handlers = useLatestRef({ onMove, onUp });
  useEffect(() => {
    const handleMove = (event: MouseEvent) => handlers.current.onMove(event);
    const handleUp = () => handlers.current.onUp();
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, [handlers]);
};

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

/** A key's name for the canvas (lower case, ' ' is 'space'). */
const keyName = (event: KeyboardEvent) => (event.key === ' ' ? 'space' : event.key.toLowerCase());

/** The key a keydown means for the canvas - null with a modifier or while typing. */
const canvasKeyOf = (event: KeyboardEvent) =>
  event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target) ? null : keyName(event);

const isHeldKey = (key: string | null): key is HeldKey => HELD_KEYS.includes(key as HeldKey);

/** A/R/M/D/O/L/I/F/Space (no modifier, not typing) held: what a press on the
 * plan does - released on keyup or leaving the window (F released: onRelease).
 * C/X switch an image edit (onEditKey, not repeated), Escape leaves what is
 * going on (onEscape). The keys count only while the mouse is over the
 * canvas (`isOver`) - Escape and a release anywhere. The handlers of the last
 * render are called. `disabled`: only the view keys (F, Space) do anything -
 * another mode has the others ("Repair order"). */
export const useHeldKey = (handlers: {
  onEscape: () => void;
  onEditKey: (edit: ImageEdit) => void;
  onRelease?: (key: HeldKey) => void;
  isOver: () => boolean;
  disabled?: boolean;
}) => {
  const [heldKey, setHeldKey] = useState<HeldKey | null>(null);
  const heldRef = useRef<HeldKey | null>(null);
  const handlersRef = useLatestRef(handlers);
  const setHeld = (key: HeldKey | null) => {
    heldRef.current = key;
    setHeldKey(key);
  };
  useEffect(() => {
    if (handlers.disabled && heldRef.current && !VIEW_KEYS.includes(heldRef.current)) {
      setHeld(null);
    }
  }, [handlers.disabled]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const key = canvasKeyOf(event);
      const { disabled, isOver } = handlersRef.current;
      if (key === 'escape') {
        if (!disabled) {
          handlersRef.current.onEscape();
        }
        return;
      }
      if (!key || !isOver() || (disabled && !VIEW_KEYS.includes(key as HeldKey))) {
        return;
      }
      if (key === 'space') {
        // Not the page scrolling.
        event.preventDefault();
      }
      const edit = EDIT_KEYS[key];
      if (edit) {
        if (!event.repeat) {
          handlersRef.current.onEditKey(edit);
        }
        return;
      }
      if (isHeldKey(key) && heldRef.current !== key) {
        setHeld(key);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const key = keyName(event);
      if (heldRef.current === key) {
        setHeld(null);
        handlersRef.current.onRelease?.(key);
      }
    };
    const release = () => setHeld(null);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', release);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', release);
    };
  }, [handlersRef]);
  return heldKey;
};

/** Draws the canvas (drawStage) whenever what it shows changes - once the image is there. */
export const useStageDrawing = (
  canvasRef: RefObject<HTMLCanvasElement | null>,
  scene: Omit<StageScene, 'image'> & { image: StageScene['image'] | null },
) => {
  const sceneRef = useLatestRef(scene);
  // Redrawn when one of these changes (not on every render).
  useEffect(
    () => {
      const { image } = sceneRef.current;
      const canvas = canvasRef.current;
      const ctx = canvas && image ? canvas.getContext('2d') : null;
      if (ctx && image) {
        drawStage(ctx, { ...sceneRef.current, image });
      }
    },
    [
      canvasRef,
      sceneRef,
      scene.image,
      scene.logical,
      scene.pixelRatio,
      scene.px,
      scene.view,
      scene.alignment,
      scene.editMode,
      scene.selection,
      scene.selectedItems,
      scene.placement,
      scene.items,
      scene.hoveredIndex,
      scene.lineMode,
      scene.group,
      scene.groupDrag,
      scene.insertGhost,
      scene.pins,
      scene.alignDrag,
      scene.calibrationPoints,
      scene.referencePoint,
      scene.repair,
      scene.fitBox,
    ],
  );
};
