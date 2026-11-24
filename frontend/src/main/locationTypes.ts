import type { SensorHeatmapLageplanData } from '../components/device/sensorHeatmapTypes';

export type LocationDetail = {
  id?: number | null;
  project_id?: number | null;
  /** Detail answer only: whether /project/<project_id>/ opens this location (else its pk URL). */
  project_main?: boolean | null;
  /** The customer's own project number (max. 16 characters) - only sent to
   * staff and customer admins; set via /v1/location/<pk>/customer-project-nr/. */
  customer_project_nr?: string | null;
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
  /** First (non-archived) measurement - "Online seit". Only on the detail endpoint. */
  first_measurement_at?: string | null;
  last_updated?: string | null;
  pe_geschaltet?: boolean | null;
  /** "de" / "en" ("" = German): the language of the invitations to new users. */
  language?: string | null;
  /** The hourly rain check (ProgeoRainEvent) runs for this location. */
  rain_check_enabled?: boolean | null;
  /** Part of a merged project (helper/location_merge.py): the project's location. */
  parent_location?: number | null;
  /** A merged project: its parts. */
  child_location_ids?: number[] | null;
  /** The location's Lageplans, active ones first (the first is the main plan). */
  lageplans?: SensorHeatmapLageplanData[] | null;
};
