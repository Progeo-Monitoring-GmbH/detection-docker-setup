import {
  plotToWorld,
  toScreen,
  type View,
  type WorldSize,
} from './heatmapCanvas';
import { plotTransform } from './heatmapChart';
import type { SensorHeatmapLocation } from './sensorHeatmapTypes';
import { repeatedTestId } from '../../testIds';
import './SuspicionMarkers.css';

/**
 * smartex® mx-PEEL: the computed suspicion points (main/computedSuspicion.ts)
 * as lettered rings over the heatmap - an HTML layer above the canvas,
 * placed with the heatmap's view, so it follows zoom and pan. It takes no
 * pointer input: the plan stays draggable under it.
 */
export type SuspicionPlanMarker = {
  id: string;
  /** Normalized position - the coordinates of the heatmap's sensor_points. */
  x: number;
  y: number;
  /** The Lageplan (view) it lies on. */
  lageplan: number | null;
  /** "A", "B", ... - the same as in the list. */
  label: string;
  state: 'neu' | 'quittiert' | 'geloest';
  /** 0..1 of the strongest point: the ring's size. */
  strength: number;
};

export type PlacedSuspicionMarker = SuspicionPlanMarker & {
  wx: number;
  wy: number;
};

/** World (plan image pixel) positions of the markers - with the same
 * alignment SensorHeatmap2D places its sensors with (plotSensors +
 * chartLayout): y mirrored unless the plan is flipped. */
export const placeSuspicionMarkers = (
  markers: SuspicionPlanMarker[] | undefined,
  location: SensorHeatmapLocation | null,
  imageSize: { width: number; height: number } | null,
  flipY: boolean,
  world: WorldSize,
): PlacedSuspicionMarker[] => {
  if (!markers?.length) {
    return [];
  }
  const { toPlotX, toPlotY } = plotTransform(location, imageSize);
  return markers
    .filter((marker) => Number.isFinite(marker.x) && Number.isFinite(marker.y))
    .map((marker) => {
      const [wx, wy] = plotToWorld(
        toPlotX(marker.x),
        toPlotY(flipY ? marker.y : 1 - marker.y),
        world,
      );
      return { ...marker, wx, wy };
    });
};

/** Ring diameter in screen pixels: 22 for the weakest, 40 for the strongest. */
export const markerSize = (strength: number) =>
  Math.round(22 + 18 * Math.max(0, Math.min(1, strength)));

type SuspicionMarkersOverlayProps = {
  markers: PlacedSuspicionMarker[];
  view: View;
  width: number;
  height: number;
};

const SuspicionMarkersOverlay = ({
  markers,
  view,
  width,
  height,
}: SuspicionMarkersOverlayProps) => (
  <div className="suspicion-markers" aria-hidden="true">
    {markers.map((marker) => {
      const [sx, sy] = toScreen(view, marker.wx, marker.wy);
      if (sx < -40 || sy < -40 || sx > width + 40 || sy > height + 40) {
        return null;
      }
      const size = markerSize(marker.strength);
      return (
        <div
          key={marker.id}
          className={`suspicion-marker suspicion-marker--${marker.state}`}
          // Position and size follow the view - the only inline values.
          style={{ left: sx, top: sy, width: size, height: size }}
          {...repeatedTestId('suspicion-marker', marker.id)}
        >
          <span className="suspicion-marker-label">{marker.label}</span>
        </div>
      );
    })}
  </div>
);

export default SuspicionMarkersOverlay;
