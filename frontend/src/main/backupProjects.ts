// Backups per database: "default" plus one database per project (named after
// ProgeoLocation.project_id, "unknown" for locations without one) - see
// progeo/helper/project_dbs.py. The backend tags every backup with its
// `project` (project id, "unknown", or null for non-project databases) and
// filters the list with ?project=<project_id|unknown|default>.

export type BackupProject = number | 'unknown' | null;

export type BackupProjectOption = {
  database: string;
  project: BackupProject;
  name: string | null;
};

// '' = every backup; otherwise the backend's ?project= value.
export type BackupProjectFilter = '' | 'default' | 'unknown' | `${number}`;

export const filterValueOf = (project: BackupProject): BackupProjectFilter =>
  project === null ? 'default' : project === 'unknown' ? 'unknown' : `${project}`;

export const parseProjectFilter = (value: string | null): BackupProjectFilter => {
  if (value === 'default' || value === 'unknown') {
    return value;
  }
  if (value && /^\d+$/.test(value)) {
    return value as `${number}`;
  }
  return '';
};

// Project of a filter value - null for "all" and for the default database.
export const projectOfFilter = (filter: BackupProjectFilter): BackupProject => {
  if (filter === 'unknown') {
    return 'unknown';
  }
  if (filter === '' || filter === 'default') {
    return null;
  }
  return Number(filter);
};

// Query string for list/reload/deleteAll - deleteAll must only ever see the
// filtered backups, so every request carries the same filter.
export const backupListQuery = (filter: BackupProjectFilter, pageSize = 1000) => {
  const params = new URLSearchParams({ page_size: `${pageSize}` });
  if (filter) {
    params.set('project', filter);
  }
  return params.toString();
};

type Translate = (key: string, options?: Record<string, unknown>) => string;

export const projectLabel = (
  t: Translate,
  project: BackupProject,
  name?: string | null,
  database?: string | null,
) => {
  if (project === null) {
    // "default" is the main database; any other non-project database keeps its name.
    return !database || database === 'default' ? t('backup_project_default') : database;
  }
  if (project === 'unknown') {
    return t('backup_project_unknown');
  }
  return name ? `${project} – ${name}` : `${project}`;
};

// Body for "create backup": a project database when one is selected,
// otherwise the default database (empty body, as before).
export const createBackupBody = (filter: BackupProjectFilter) =>
  filter && filter !== 'default' ? { project: filter } : {};
