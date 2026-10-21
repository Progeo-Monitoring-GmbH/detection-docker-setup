/**
 * Payload of GET /v1/location/<pk>/heatmap/ (LocationViewSet.get_heatmap_data,
 * also /v1/demo/<pk>/heatmap/) and the Lageplan data it carries
 * (ProgeoLageplanSerializer) - shared by SensorHeatmap2D and the views that
 * load it.
 */

/** One Lageplan of a location, as ProgeoLageplanSerializer sends it. */
export type SensorHeatmapLageplanData = {
  id?: number;
  name?: string | null;
  /** Media path of the plan image ("media/uploads/..."). */
  url?: string | null;
  offset_x?: number | null;
  offset_y?: number | null;
  scale_x?: number | null;
  scale_y?: number | null;
  flip_x?: boolean | null;
  flip_y?: boolean | null;
  offset_latitude?: number | null;
  offset_longitude?: number | null;
  /** Reference point of the positions in meters (image pixels). */
  reference_x?: number | null;
  reference_y?: number | null;
  meters_per_pixel?: number | null;
  is_active?: boolean;
  location_id?: number;
  location_name?: string | null;
  last_fetched?: string | null;
  last_updated?: string | null;
};

/**
 * The location of a heatmap (LocationSerializer, every model field) - plus
 * the alignment of the selected Lageplan, which SensorHeatmap2D merges in
 * (lageplan_url, offsets, scale, flip, reference point, meters per pixel).
 */
export type SensorHeatmapLocation = Omit<SensorHeatmapLageplanData, 'id' | 'name' | 'url'> & {
  id?: number;
  name?: string | null;
  project_id?: number | null;
  project_type?: number | null;
  alarm_threshold?: number | null;
  lageplan_url?: string | null;
  lageplans?: SensorHeatmapLageplanData[] | null;
  [field: string]: unknown;
};

/** A placed measure point of the heatmap (ProgeoMeasurePoint). */
export type SensorHeatmapPoint = {
  /** sensor_order - the key of its series in `data`. */
  pos: number;
  /** Normalized position on the plan (0..1, y downwards). */
  x: number;
  y: number;
  /** Position in meters; null while the plan isn't calibrated. */
  x_m?: number | null;
  y_m?: number | null;
  name?: string | null;
  last_value?: number | null;
  threshold?: number | null;
};

export type SensorHeatmapResponse = {
  location?: SensorHeatmapLocation | null;
  limit?: number;
  from?: string | null;
  to?: string | null;
  days?: number | null;
  /** Measurements in the window, of which `timestamps` are the frames. */
  total?: number;
  /** Per sensor (1-based, = sensor_points[].pos) one value per timestamp. */
  data: Record<string, Array<number | null>>;
  /** Unix seconds, oldest first. */
  timestamps: number[];
  sensor_points?: SensorHeatmapPoint[];
};
