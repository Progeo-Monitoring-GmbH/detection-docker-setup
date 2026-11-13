import type { SensorHeatmapLageplanData } from '../components/device/sensorHeatmapTypes';

export type LocationDetail = {
  id?: number | null;
  project_id?: number | null;
  name?: string | null;
  address?: string | null;
  city?: string | null;
  plz?: string | null;
  alarm_threshold?: number | null;
  latitude?: number | null;
  longitude?: number | null;
  // Also returned by LocationSerializer (fields="__all__" + computed) but
  // not previously typed here - added for the Objekt tab.
  manager?: string | null;
  telefon?: string | null;
  mail?: string | null;
  country?: string | null;
  contact_person?: string | null;
  project_type?: number | null;
  device_count?: number | null;
  measurement_count?: number | null;
  last_measurement_at?: string | null;
  last_updated?: string | null;
  pe_geschaltet?: boolean | null;
  /** The hourly rain check (ProgeoRainEvent) runs for this location. */
  rain_check_enabled?: boolean | null;
  /** The location's Lageplans, active ones first (the first is the main plan). */
  lageplans?: SensorHeatmapLageplanData[] | null;
};
