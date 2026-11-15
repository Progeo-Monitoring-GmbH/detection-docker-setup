import { useEffect, useLayoutEffect, useRef } from 'react';
import L from 'leaflet';
import { useMap } from 'react-leaflet';
import { useZoomWheel } from '../components/ui/wheelZoom';

/** Below this many pixels a press is a click (marker), not a frame. */
const MIN_FRAME_PX = 6;
/** Wheel events closer together are one zoom step (trackpads send bursts). */
const WHEEL_STEP_MS = 60;

const useLatest = (value) => {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
};

/**
 * Drag a frame over the map to zoom into it (`enabled`, the map's
 * "Zoom to area" mode) - dragging then no longer moves the map. Off: the map
 * moves by dragging, and Leaflet's own Shift + drag frame still zooms.
 * `onZoomed` after each zoom (the user took over the view).
 */
export const AreaZoom = ({ enabled, onZoomed }) => {
  const map = useMap();
  const zoomed = useLatest(onZoomed);

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }
    const container = map.getContainer();
    map.dragging.disable();
    map.boxZoom.disable();
    container.classList.add('locmap-area-zoom');

    let start = null;
    let frame = null;
    let swallowClick = false;
    const pointOf = (event) => map.mouseEventToContainerPoint(event);

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
    };
    const onDown = (event) => {
      if (event.button !== 0 || event.target.closest('.leaflet-control')) {
        return;
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

    container.addEventListener('mousedown', onDown);
    container.addEventListener('click', onClickCapture, true);
    return () => {
      container.removeEventListener('mousedown', onDown);
      container.removeEventListener('click', onClickCapture, true);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (frame) {
        L.DomUtil.remove(frame);
      }
      container.classList.remove('locmap-area-zoom');
      map.dragging.enable();
      map.boxZoom.enable();
    };
  }, [map, enabled, zoomed]);

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
