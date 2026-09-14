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
  project_type?: number | null;
  device_count?: number | null;
  measurement_count?: number | null;
  last_measurement_at?: string | null;
  pe_geschaltet?: boolean | null;
};
