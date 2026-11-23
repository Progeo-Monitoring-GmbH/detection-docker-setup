/**
 * Hooks of the plan canvas (ImageCanvasStage) for what is shown and the
 * input around it: loading the plan image, the canvas' shown width, pan and
 * zoom (Ctrl + wheel only), the window's mouse and the held keys, and
 * drawing the canvas.
 */
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import axiosConfig from '../../axiosConfig';
import type { AuthContextType } from '../../../hooks/CoreAuthProvider';
import { drawStage, type StageScene } from './drawImageCanvas';
import {
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  clientToCanvas,
  pixelRatioFor,
  wheelZoomFactor,
  zoomedView,
  type ImagePoint,
  type PlanView,
} from './imageCanvasGeometry';
import { EDIT_KEYS, HELD_KEYS, type HeldKey, type ImageEdit } from './imageCanvasModes';
import { isZoomWheel, useWheelHint } from './wheelZoom';

/** The plan image: local previews (blob:/data:) load directly; backend media
 * requires the Authorization header, which a plain <img> request can't send. */
export const usePlanImage = (auth: AuthContextType, imageUrl: string | undefined) => {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [imageError, setImageError] = useState('');
  useEffect(() => {
    setImage(null);
    setImageError('');
    if (!imageUrl) {
      return undefined;
    }

    let cancelled = false;
    let objectUrl: string | null = null;
    const loadImage = (src: string) => {
      const nextImage = new Image();
      nextImage.onload = () => {
        if (!cancelled) {
          setImage(nextImage);
        }
      };
      nextImage.onerror = () => {
        if (!cancelled) {
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

/** Pan and zoom of the plan. */
export const usePlanView = (canvasWidth: number) => {
  const [zoom, setZoom] = useState(1);
  const [offsetX, setOffsetX] = useState(0);
  const [offsetY, setOffsetY] = useState(0);
  const view = useMemo<PlanView>(() => ({ zoom, offsetX, offsetY }), [zoom, offsetX, offsetY]);
  const setView = (next: PlanView) => {
    setZoom(next.zoom);
    setOffsetX(next.offsetX);
    setOffsetY(next.offsetY);
  };
  return {
    view,
    /** Zoom by `factor` around a canvas point (default: the middle). */
    zoomAround: (factor: number, at?: ImagePoint) => setView(zoomedView(view, factor, canvasWidth, at)),
    resetView: () => setView({ zoom: 1, offsetX: 0, offsetY: 0 }),
    panTo: (x: number, y: number) => {
      setOffsetX(x);
      setOffsetY(y);
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
  const zoomAroundRef = useRef(zoomAround);
  zoomAroundRef.current = zoomAround;
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
  }, [canvasRef, showWheelHint]);
  return wheelHint;
};

/** The mouse anywhere on the page (a drag goes on off the canvas) - the
 * handlers of the last render are called. */
export const useWindowPointer = (onMove: (event: MouseEvent) => void, onUp: () => void) => {
  const handlers = useRef({ onMove, onUp });
  handlers.current = { onMove, onUp };
  useEffect(() => {
    const handleMove = (event: MouseEvent) => handlers.current.onMove(event);
    const handleUp = () => handlers.current.onUp();
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, []);
};

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

/** The key a keydown means for the canvas (lower case) - null with a modifier or while typing. */
const canvasKeyOf = (event: KeyboardEvent) =>
  event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target) ? null : event.key.toLowerCase();

const isHeldKey = (key: string | null): key is HeldKey => HELD_KEYS.includes(key as HeldKey);

/** A/R/M/D/O/L/I (no modifier, not typing) held: what a press on the plan
 * does - released on keyup or leaving the window. C/X switch an image edit
 * (onEditKey, not repeated), Escape leaves what is going on (onEscape). The
 * handlers of the last render are called. `disabled`: no key does anything
 * (another mode has the keys - "Repair order"). */
export const useHeldKey = (handlers: {
  onEscape: () => void;
  onEditKey: (edit: ImageEdit) => void;
  disabled?: boolean;
}) => {
  const [heldKey, setHeldKey] = useState<HeldKey | null>(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  useEffect(() => {
    if (handlers.disabled) {
      setHeldKey(null);
    }
  }, [handlers.disabled]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (handlersRef.current.disabled) {
        return;
      }
      const key = canvasKeyOf(event);
      if (key === 'escape') {
        handlersRef.current.onEscape();
        return;
      }
      const edit = key ? EDIT_KEYS[key] : undefined;
      if (edit) {
        if (!event.repeat) {
          handlersRef.current.onEditKey(edit);
        }
        return;
      }
      if (isHeldKey(key)) {
        setHeldKey(key);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      setHeldKey((current) => (current === key ? null : current));
    };
    const release = () => setHeldKey(null);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', release);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', release);
    };
  }, []);
  return heldKey;
};

/** Draws the canvas (drawStage) whenever what it shows changes - once the image is there. */
export const useStageDrawing = (
  canvasRef: RefObject<HTMLCanvasElement | null>,
  scene: Omit<StageScene, 'image'> & { image: StageScene['image'] | null },
) => {
  const sceneRef = useRef(scene);
  sceneRef.current = scene;
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
    ],
  );
};
