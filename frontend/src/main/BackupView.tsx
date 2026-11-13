import { useCallback, useEffect, useMemo, useState } from 'react';
import DataTable, { type TableColumn } from 'react-data-table-component';
import { useParams, useSearchParams } from 'react-router';
import { useSnackbar } from 'notistack';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import usePermissions from '../../hooks/usePermissions';
import axiosConfig from '../axiosConfig';
import { errorReason, showErrorBar, showSuccessBar } from '../components/ui/Snackbar.jsx';
import PanelCard from '../components/ui/kit/PanelCard';
import PillButton from '../components/ui/kit/PillButton';
import ConfirmDialog from '../components/ui/kit/ConfirmDialog';
import DeleteIconButton from '../components/ui/kit/DeleteIconButton';
import { formatDate } from './dateFormat';
import { repeatedTestId } from '../testIds';
import './BackupView.css';
import {
  type BackupProject,
  type BackupProjectOption,
  backupListQuery,
  createBackupBody,
  filterValueOf,
  parseDateFilter,
  parseProjectFilter,
  projectLabel,
  projectOfFilter,
} from './backupProjects';

type BackupRow = {
  id: number;
  name: string;
  size: string | null;
  is_compressed: boolean;
  created_at: string | null;
  // Database the dump belongs to and its project - see backupProjects.ts.
  database: string | null;
  project: BackupProject;
  project_name: string | null;
};

const dataTableStyles = {
  headRow: {
    style: {
      background: 'var(--progeo-surface)',
      borderBottomWidth: '0px',
      borderRadius: 11,
    },
  },
  headCells: {
    style: {
      fontSize: 10.5,
      letterSpacing: '.06em',
      textTransform: 'uppercase' as const,
      color: '#8B8383',
      fontWeight: 500,
    },
  },
  rows: {
    style: {
      fontSize: 13,
      color: 'var(--progeo-blue)',
      borderBottomColor: 'var(--progeo-track-soft)',
      minHeight: '48px',
    },
  },
  pagination: {
    style: {
      background: 'transparent',
      borderTopWidth: '0px',
      color: '#8B8383',
    },
  },
};

const BackupView = () => {
  const auth = useAuth();
  const { account } = useParams();
  const { t } = useTranslation();
  const { enqueueSnackbar } = useSnackbar();
  const { hasPermission } = usePermissions();
  // Backend: delete/deleteAll require module_backup_delete.
  const canDelete = hasPermission('module_backup_delete');

  const [backups, setBackups] = useState<BackupRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [selectedRows, setSelectedRows] = useState<BackupRow[]>([]);
  const [clearSelectionToggle, setClearSelectionToggle] = useState(false);
  const [projects, setProjects] = useState<BackupProjectOption[]>([]);

  // The filters live in the URL (?project=4711&date=2026-10-24&latest=1), so
  // a filtered view can be linked. The backend filters - list, reload and
  // deleteAll all carry them, so "delete all" never reaches beyond the shown
  // backups.
  const [searchParams, setSearchParams] = useSearchParams();
  const projectFilter = parseProjectFilter(searchParams.get('project'));
  const dateFilter = parseDateFilter(searchParams.get('date'));
  const latestOnly = searchParams.get('latest') === '1';
  const listQuery = backupListQuery({ project: projectFilter, date: dateFilter, latest: latestOnly });
  const hasFilter = Boolean(projectFilter || dateFilter || latestOnly);

  // Typed text of the project field - applied on Enter/blur or when it
  // matches a project, so half-typed ids don't trigger requests.
  const [projectInput, setProjectInput] = useState<string>(projectFilter);
  useEffect(() => setProjectInput(projectFilter), [projectFilter]);

  const hasSelection = selectedRows.length > 0;
  const isBulkBusy = busyAction === 'delete-all' || busyAction === 'delete-selected';
  const isDownloading = busyAction === 'download-many';

  const selectedProject = useMemo(
    () => projects.find((option) => filterValueOf(option.project) === projectFilter),
    [projects, projectFilter],
  );

  const changeFilters = (changes: Record<string, string | null>) => {
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev);
        Object.entries(changes).forEach(([key, value]) => {
          if (value) {
            params.set(key, value);
          } else {
            params.delete(key);
          }
        });
        return params;
      },
      { replace: true },
    );
    setSelectedRows([]);
    setClearSelectionToggle((prev) => !prev);
  };

  const applyProjectInput = (value: string) => {
    const next = parseProjectFilter(value.trim());
    // Unparseable text (e.g. a half-typed name) keeps the current filter.
    if (next !== projectFilter && (next || !value.trim())) {
      changeFilters({ project: next });
    } else {
      setProjectInput(projectFilter);
    }
  };

  const onProjectInputChange = (value: string) => {
    setProjectInput(value);
    // Picked from the suggestions (or typed out in full) - apply right away.
    if (projects.some((option) => filterValueOf(option.project) === value)) {
      changeFilters({ project: value });
    }
  };

  const applyResponse = (response: { data?: { elements?: BackupRow[] } }) => {
    setBackups((response?.data?.elements || []) as BackupRow[]);
  };

  const loadBackups = useCallback(() => {
    setLoading(true);
    void axiosConfig.perform_get(
      auth,
      `/v1/${account}/backup/?${listQuery}`,
      (response) => {
        applyResponse(response);
        setLoading(false);
      },
      (error) => {
        showErrorBar(enqueueSnackbar, t('backup_load_error', { reason: errorReason(error) }));
        setLoading(false);
      },
    );
  }, [auth, account, listQuery, enqueueSnackbar, t]);

  useEffect(() => {
    loadBackups();
  }, [loadBackups]);

  useEffect(() => {
    void axiosConfig.perform_get(
      auth,
      `/v1/${account}/backup/projects/`,
      (response) => setProjects((response?.data?.projects || []) as BackupProjectOption[]),
      () => setProjects([]),
    );
  }, [auth, account]);

  const runAction = (
    key: string,
    url: string,
    successMessage: string,
    errorMessageKey: string,
    body: Record<string, unknown> = {},
  ) => {
    setBusyAction(key);
    void axiosConfig.perform_post(
      auth,
      `${url}${url.includes('?') ? '&' : '?'}${listQuery}`,
      body,
      (response) => {
        applyResponse(response);
        showSuccessBar(enqueueSnackbar, successMessage);
        setBusyAction(null);
      },
      (error) => {
        showErrorBar(enqueueSnackbar, t(errorMessageKey, { reason: errorReason(error) }));
        setBusyAction(null);
      },
    );
  };

  const reloadBackups = () =>
    runAction(
      'reload',
      `/v1/${account}/backup/reload/`,
      t('backup_reloaded'),
      'backup_reload_error',
    );

  // Backs up the selected project's database, or "default" when no project
  // (or the main database) is selected.
  const createBackup = () =>
    runAction(
      'create',
      `/v1/${account}/backup/create/`,
      t('backup_created'),
      'backup_create_error',
      createBackupBody(projectFilter),
    );

  const filteredProject = projectOfFilter(projectFilter);
  const projectFilterLabel =
    filteredProject !== null ? projectLabel(t, filteredProject, selectedProject?.name) : null;

  const confirmDeleteAllBackups = () => {
    setConfirmOpen(false);
    runAction(
      'delete-all',
      `/v1/${account}/backup/deleteAll/`,
      t('backup_deleted_all'),
      'backup_delete_all_error',
    );
  };

  const confirmDeleteSelectedBackups = () => {
    setConfirmOpen(false);
    const targets = selectedRows;
    setBusyAction('delete-selected');
    Promise.all(
      targets.map(
        (backup) =>
          new Promise<void>((resolve) => {
            void axiosConfig.perform_post(
              auth,
              `/v1/${account}/backup/${backup.id}/delete/`,
              {},
              () => resolve(),
              (error) => {
                const reason = errorReason(error);
                showErrorBar(
                  enqueueSnackbar,
                  t('backup_delete_error', { reason: `${backup.name}: ${reason}` }),
                );
                resolve();
              },
            );
          }),
      ),
    ).then(() => {
      showSuccessBar(
        enqueueSnackbar,
        t('backup_deleted_selected', { count: targets.length }),
      );
      setSelectedRows([]);
      setClearSelectionToggle((prev) => !prev);
      setBusyAction(null);
      loadBackups();
    });
  };

  const deleteBackup = (backup: BackupRow) =>
    runAction(
      `delete-${backup.id}`,
      `/v1/${account}/backup/${backup.id}/delete/`,
      t('backup_deleted'),
      'backup_delete_error',
    );

  const restoreBackup = (backup: BackupRow) =>
    runAction(
      `restore-${backup.id}`,
      `/v1/${account}/backup/${backup.id}/restore/`,
      t('backup_restored', { name: backup.name }),
      'backup_restore_error',
    );

  // Fetches a short-lived signed link, then lets the browser download the
  // file natively - dumps can be several GB, too big to buffer as a blob.
  const startDownload = (backup: BackupRow) =>
    new Promise<void>((resolve) => {
      void axiosConfig.perform_get(
        auth,
        `/v1/${account}/backup/${backup.id}/download/`,
        (response) => {
          const token = response?.data?.token as string | undefined;
          if (token) {
            const link = document.createElement('a');
            link.href = axiosConfig.holder.getUri({
              url: `/v1/${account}/backup/download/file/`,
              params: { token },
            });
            link.download = backup.name;
            link.click();
          }
          resolve();
        },
        (error) => {
          const reason = errorReason(error);
          showErrorBar(
            enqueueSnackbar,
            t('backup_download_error', { reason: `${backup.name}: ${reason}` }),
          );
          resolve();
        },
      );
    });

  const downloadBackup = (backup: BackupRow) => {
    setBusyAction(`download-${backup.id}`);
    void startDownload(backup).then(() => setBusyAction(null));
  };

  // Downloads the selected backups, else every shown one (e.g. all of a day,
  // or the latest per project). One after another with a pause - browsers
  // drop downloads started in the same instant (and may ask once to allow
  // multiple downloads). Each gets a fresh token, so they never expire.
  const downloadBackups = async () => {
    const targets = hasSelection ? selectedRows : backups;
    setBusyAction('download-many');
    for (const [index, backup] of targets.entries()) {
      if (index > 0) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      await startDownload(backup);
    }
    setBusyAction(null);
  };

  const columns: TableColumn<BackupRow>[] = [
    {
      name: t('backup_col_name'),
      selector: (row) => row.name,
      sortable: true,
      grow: 2,
      wrap: true,
      cell: (row) => (
        <button
          type="button"
          onClick={() => downloadBackup(row)}
          disabled={busyAction === `download-${row.id}`}
          title={t('backup_download')}
          className={busyAction === `download-${row.id}` ? 'backup-name backup-name--busy' : 'backup-name'}
          {...repeatedTestId('backup-download', row.id)}
        >
          {row.name}
        </button>
      ),
    },
    {
      name: t('backup_col_project'),
      selector: (row) => projectLabel(t, row.project, row.project_name, row.database),
      sortable: true,
      grow: 1,
      wrap: true,
    },
    {
      name: t('backup_col_date'),
      selector: (row) => row.created_at || '',
      sortable: true,
      cell: (row) => <span>{formatDate(row.created_at)}</span>,
      width: '190px',
    },
    {
      name: t('backup_col_size'),
      selector: (row) => row.size || '',
      sortable: true,
      width: '110px',
    },
    {
      name: t('backup_col_compressed'),
      selector: (row) => (row.is_compressed ? 1 : 0),
      sortable: true,
      cell: (row) => (
        <span className={row.is_compressed ? 'backup-compressed backup-compressed--yes' : 'backup-compressed'}>
          {row.is_compressed
            ? t('backup_compressed_yes')
            : t('backup_compressed_no')}
        </span>
      ),
      width: '160px',
    },
    {
      name: t('backup_col_actions'),
      cell: (row) => (
        <div className="backup-row-actions">
          <button
            type="button"
            onClick={() => restoreBackup(row)}
            disabled={isBulkBusy || busyAction === `restore-${row.id}`}
            className="backup-small-button"
            {...repeatedTestId('backup-restore', row.id)}
          >
            {t('backup_restore')}
          </button>
          {canDelete && (
            <DeleteIconButton
              label={t('backup_delete')}
              onClick={() => deleteBackup(row)}
              disabled={isBulkBusy || busyAction === `delete-${row.id}`}
              testId="backup-delete"
              testKey={row.id}
            />
          )}
        </div>
      ),
      width: '260px',
    },
  ];

  return (
    <div className="backup-view" data-testid="page-backup">
      <PanelCard title={t('backup_actions')} testId="backup-actions">
        <div className="backup-actions">
          <PillButton
            label={t('backup_reload')}
            onClick={reloadBackups}
            disabled={busyAction === 'reload'}
            testId="backup-reload"
          />
          <button
            type="button"
            onClick={createBackup}
            disabled={busyAction === 'create'}
            className="backup-button backup-button--primary"
            data-testid="backup-create"
          >
            {projectFilterLabel
              ? t('backup_create_for', { project: projectFilterLabel })
              : t('backup_create')}
          </button>
          {canDelete && (
            <button
              type="button"
              onClick={() => setConfirmOpen(true)}
              disabled={isBulkBusy}
              className="backup-button backup-button--danger"
              data-testid="backup-delete-bulk"
            >
              {hasSelection
                ? t('backup_delete_selected', { count: selectedRows.length })
                : t('backup_delete_all')}
            </button>
          )}
        </div>
      </PanelCard>

      <PanelCard title={t('backup_available')} testId="backup-list">
        <div className="backup-filters" data-testid="backup-filters">
          <label htmlFor="backup-project-filter" className="backup-filter-label">
            {t('backup_filter_project')}
          </label>
          {/* Type a project id (or pick from the suggestions, which also
              match location names) instead of scrolling a long dropdown. */}
          <input
            id="backup-project-filter"
            className="form-control form-control-sm backup-project-input"
            list="backup-project-options"
            data-testid="backup-filter-project"
            placeholder={t('backup_project_all')}
            title={projectFilterLabel ?? undefined}
            value={projectInput}
            onChange={(event) => onProjectInputChange(event.target.value)}
            onBlur={(event) => applyProjectInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                applyProjectInput(event.currentTarget.value);
              }
            }}
          />
          <datalist id="backup-project-options">
            {projects.map((option) => (
              <option key={option.database} value={filterValueOf(option.project)}>
                {projectLabel(t, option.project, option.name, option.database)}
              </option>
            ))}
          </datalist>
          <label htmlFor="backup-date-filter" className="backup-filter-label backup-filter-label--spaced">
            {t('backup_filter_date')}
          </label>
          <input
            id="backup-date-filter"
            type="date"
            className="form-control form-control-sm backup-date-input"
            data-testid="backup-filter-date"
            value={dateFilter}
            onChange={(event) => changeFilters({ date: parseDateFilter(event.target.value) })}
          />
          <label className="backup-latest">
            <input
              type="checkbox"
              className="form-check-input backup-latest-check"
              data-testid="backup-filter-latest"
              checked={latestOnly}
              onChange={(event) => changeFilters({ latest: event.target.checked ? '1' : null })}
            />
            {t('backup_filter_latest')}
          </label>
          {hasFilter && (
            <button
              type="button"
              onClick={() => changeFilters({ project: null, date: null, latest: null })}
              className="backup-small-button"
              data-testid="backup-filter-clear"
            >
              {t('backup_filter_clear')}
            </button>
          )}
          <button
            type="button"
            onClick={() => void downloadBackups()}
            disabled={isDownloading || backups.length === 0}
            className="backup-button backup-button--primary backup-button--download"
            data-testid="backup-download-many"
          >
            {hasSelection
              ? t('backup_download_selected', { count: selectedRows.length })
              : t('backup_download_shown', { count: backups.length })}
          </button>
        </div>
        <DataTable
          columns={columns}
          data={backups}
          pagination
          progressPending={loading}
          highlightOnHover
          dense
          // Row selection feeds "download selected" and "delete selected".
          selectableRows
          onSelectedRowsChange={({ selectedRows: rows }) => setSelectedRows(rows)}
          clearSelectedRows={clearSelectionToggle}
          noDataComponent={
            <div className="backup-empty" data-testid="backup-empty">
              {t('backup_empty')}
            </div>
          }
          customStyles={dataTableStyles}
        />
      </PanelCard>

      <ConfirmDialog
        show={confirmOpen}
        title={
          hasSelection
            ? t('backup_delete_selected_confirm_title', { count: selectedRows.length })
            : t('backup_delete_all_confirm_title')
        }
        message={
          <div>
            <div>
              {hasSelection
                ? t('backup_delete_selected_confirm_body')
                : t('backup_delete_all_confirm_body')}
            </div>
            <ul className="backup-confirm-list" data-testid="backup-delete-confirm-list">
              {(hasSelection ? selectedRows : backups).map((backup) => (
                <li key={backup.id} {...repeatedTestId('backup-delete-confirm-item', backup.id)}>{backup.name}</li>
              ))}
            </ul>
          </div>
        }
        confirmLabel={t('backup_confirm_yes')}
        cancelLabel={t('backup_confirm_cancel')}
        onConfirm={hasSelection ? confirmDeleteSelectedBackups : confirmDeleteAllBackups}
        onCancel={() => setConfirmOpen(false)}
        confirming={isBulkBusy}
        testId="backup-delete-confirm"
      />
    </div>
  );
};

export default BackupView;
