import { useEffect, useRef } from 'react';
import L from 'leaflet';
import { useMap } from 'react-leaflet';
import { isTypingTarget } from '../components/ui/keys';
import { useLatestRef } from '../components/ui/useLatestRef';
import { useZoomWheel } from '../components/ui/wheelZoom';

/** Below this many pixels a press is a click (marker), not a frame. */
const MIN_FRAME_PX = 6;
/** Wheel events closer together are one zoom step (trackpads send bursts). */
const WHEEL_STEP_MS = 60;

/** The key that turns dragging into "zoom to this area". */
const AREA_ZOOM_KEY = 'z';

/**
 * Hold Z and drag a frame over the map to zoom into it; without Z dragging
 * moves the map as usual (Leaflet's own Shift + drag frame zooms as well).
 * While Z is held the map doesn't move and shows a crosshair. Z typed into
 * a field (the search) does nothing. `onZoomed` after each zoom (the user
 * took over the view).
 */
export const AreaZoom = ({ onZoomed }) => {
  const map = useMap();
  const zoomed = useLatestRef(onZoomed);

  useEffect(() => {
    const container = map.getContainer();
    let held = false;
    let start = null;
    let frame = null;
    let swallowClick = false;
    const pointOf = (event) => map.mouseEventToContainerPoint(event);

    const hold = (on) => {
      if (held === on) {
        return;
      }
      held = on;
      container.classList.toggle('locmap-area-zoom', on);
      // Disabled while held: a drag begun with Z draws the frame, it doesn't move the map.
      if (on) {
        map.dragging.disable();
      } else if (!start) {
        map.dragging.enable();
      }
    };
    const onKeyDown = (event) => {
      if (event.key.toLowerCase() === AREA_ZOOM_KEY && !event.ctrlKey && !event.metaKey && !event.altKey
          && !isTypingTarget(event.target)) {
        hold(true);
      }
    };
    const onKeyUp = (event) => {
      if (event.key.toLowerCase() === AREA_ZOOM_KEY) {
        hold(false);
      }
    };
    const onBlur = () => hold(false);

    const onMove = (event) => {
      const current = pointOf(event);
      if (!frame && start.distanceTo(current) < MIN_FRAME_PX) {
        return;
      }
      frame = frame || L.DomUtil.create('div', 'locmap-zoom-frame', container);
      const topLeft = L.point(Math.min(start.x, current.x), Math.min(start.y, current.y));
      L.DomUtil.setPosition(frame, topLeft);
      frame.style.width = `${Math.abs(current.x - start.x)}px`;
      frame.style.height = `${Math.abs(current.y - start.y)}px`;
    };
    const onUp = (event) => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (frame) {
        const bounds = L.latLngBounds(map.containerPointToLatLng(start), map.containerPointToLatLng(pointOf(event)));
        L.DomUtil.remove(frame);
        frame = null;
        swallowClick = true; // the click ending the frame is no marker click
        map.fitBounds(bounds);
        zoomed.current?.();
      }
      start = null;
      if (!held) {
        map.dragging.enable(); // Z was let go during the drag
      }
    };
    const onDown = (event) => {
      if (!held || event.button !== 0 || event.target.closest('.leaflet-control')) {
        return; // without Z: Leaflet moves the map
      }
      start = pointOf(event);
      event.preventDefault(); // no text selection while framing
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    };
    const onClickCapture = (event) => {
      if (swallowClick) {
        swallowClick = false;
        event.stopPropagation();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    container.addEventListener('mousedown', onDown);
    container.addEventListener('click', onClickCapture, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      container.removeEventListener('mousedown', onDown);
      container.removeEventListener('click', onClickCapture, true);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (frame) {
        L.DomUtil.remove(frame);
      }
      container.classList.remove('locmap-area-zoom');
      map.dragging.enable();
    };
  }, [map, zoomed]);

  return null;
};

/**
 * Ctrl (or ⌘) + wheel zooms at the pointer, the plain wheel scrolls the page
 * and calls `onPlain` (the hint) - like every plan and plot (wheelZoom.tsx).
 * The map's own scrollWheelZoom stays off.
 */
export const CtrlWheelZoom = ({ onZoomed, onPlain }) => {
  const map = useMap();
  const container = useRef(map.getContainer());
  const lastStep = useRef(0);

  useZoomWheel(
    container,
    (event) => {
      const now = performance.now();
      if (now - lastStep.current < WHEEL_STEP_MS) {
        return;
      }
      lastStep.current = now;
      map.setZoomAround(map.mouseEventToContainerPoint(event), map.getZoom() + (event.deltaY < 0 ? 1 : -1));
      onZoomed?.();
    },
    onPlain,
  );
  return null;
};
