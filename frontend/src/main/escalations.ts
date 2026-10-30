/**
 * Escalations of projects (/v1/escalation/, EscalationViewSet): opened by
 * superusers in the project portal (EscalationBanner), worked on by staff in
 * the Escalations page (EscalationsView). Every change is an entry of the
 * escalation's protocol.
 */

export type EscalationStatus = 'open' | 'in_progress' | 'waiting' | 'closed';

export type EscalationEntryKind = 'created' | 'comment' | 'status' | 'assigned' | 'closed';

export type EscalationEntry = {
  id: number;
  kind: EscalationEntryKind;
  author: number | null;
  author_name: string | null;
  text: string;
  /** The change: status values ({from, to}) or users ({from, to, from_name, to_name}). */
  data: Record<string, unknown>;
  created: string;
};

export type Escalation = {
  id: number;
  location: number;
  location_name: string | null;
  project_id: number | null;
  title: string;
  status: EscalationStatus;
  assigned_to: number | null;
  assigned_to_name: string | null;
  created_by: number | null;
  created_by_name: string | null;
  created: string;
  updated: string;
  closed_at: string | null;
  closed_by: number | null;
  closed_by_name: string | null;
  entry_count: number;
  /** Only in the detail (GET /v1/escalation/<id>/ and every change). */
  entries?: EscalationEntry[];
};

export type StaffUser = { id: number; name: string };

export const ESCALATION_URL = '/v1/escalation/';

/** The statuses staff can set - closing is its own action. */
export const SETTABLE_STATUSES: EscalationStatus[] = ['open', 'in_progress', 'waiting'];

export const STATUS_STYLE: Record<EscalationStatus, { color: string; bg: string }> = {
  open: { color: '#B23A12', bg: '#FCE9E2' },
  in_progress: { color: '#9A7208', bg: '#FBF3DE' },
  waiting: { color: '#2F5F8A', bg: '#E4EEF7' },
  closed: { color: '#3F7A1C', bg: '#EBF4E3' },
};

/** i18n key of a status. */
export const statusKey = (status: EscalationStatus) => `escalation_status_${status}`;

/** Path of an escalation in the Escalations page. */
export const escalationPath = (id: number) => `/escalations/${id}`;
