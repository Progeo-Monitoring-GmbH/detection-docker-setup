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
import { formatDateTime } from './dateFormat';
import {
  type BackupProject,
  type BackupProjectOption,
  backupListQuery,
  createBackupBody,
  filterValueOf,
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

const buttonStyle = (variant: 'primary' | 'danger', disabled: boolean) => ({
  height: 38,
  padding: '0 16px',
  border: 'none',
  borderRadius: 10,
  fontFamily: 'inherit',
  fontSize: 13.5,
  fontWeight: 500,
  cursor: disabled ? 'default' : 'pointer',
  opacity: disabled ? 0.6 : 1,
  ...(variant === 'primary'
    ? {
        background: 'var(--progeo-orange)',
        color: '#fff',
        boxShadow: '0 4px 14px rgba(235, 99, 59, .28)',
      }
    : {
        background: '#FBEAE4',
        color: '#C44D26',
      }),
});

const smallActionButtonStyle = (disabled: boolean) => ({
  height: 30,
  padding: '0 12px',
  border: 'none',
  borderRadius: 8,
  background: 'var(--progeo-surface)',
  color: 'var(--progeo-blue)',
  fontFamily: 'inherit',
  fontSize: 12.5,
  fontWeight: 500,
  cursor: disabled ? 'default' : 'pointer',
  opacity: disabled ? 0.6 : 1,
});

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

  // The project filter lives in the URL (?project=4711), so a filtered view
  // can be linked. The backend filters - list, reload and deleteAll all
  // carry it, so "delete all" never reaches beyond the shown backups.
  const [searchParams, setSearchParams] = useSearchParams();
  const projectFilter = parseProjectFilter(searchParams.get('project'));
  const listQuery = backupListQuery(projectFilter);

  const hasSelection = selectedRows.length > 0;
  const isBulkBusy = busyAction === 'delete-all' || busyAction === 'delete-selected';

  const selectedProject = useMemo(
    () => projects.find((option) => filterValueOf(option.project) === projectFilter),
    [projects, projectFilter],
  );

  const changeProjectFilter = (value: string) => {
    const next = parseProjectFilter(value);
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev);
        if (next) {
          params.set('project', next);
        } else {
          params.delete('project');
        }
        return params;
      },
      { replace: true },
    );
    setSelectedRows([]);
    setClearSelectionToggle((prev) => !prev);
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
  const downloadBackup = (backup: BackupRow) => {
    setBusyAction(`download-${backup.id}`);
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
        setBusyAction(null);
      },
      (error) => {
        showErrorBar(enqueueSnackbar, t('backup_download_error', { reason: errorReason(error) }));
        setBusyAction(null);
      },
    );
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
          style={{
            border: 'none',
            background: 'none',
            padding: 0,
            fontFamily: 'inherit',
            fontSize: 'inherit',
            color: 'var(--progeo-blue)',
            textAlign: 'left',
            textDecoration: 'underline',
            textUnderlineOffset: 3,
            cursor: busyAction === `download-${row.id}` ? 'progress' : 'pointer',
            wordBreak: 'break-all',
          }}
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
      cell: (row) => <span>{formatDateTime(row.created_at)}</span>,
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
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            padding: '3px 9px',
            borderRadius: 999,
            background: row.is_compressed
              ? 'rgba(97, 170, 197, .18)'
              : 'var(--progeo-track-soft)',
            color: row.is_compressed ? 'var(--progeo-blue)' : '#8B8383',
          }}
        >
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
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            onClick={() => restoreBackup(row)}
            disabled={isBulkBusy || busyAction === `restore-${row.id}`}
            style={smallActionButtonStyle(isBulkBusy || busyAction === `restore-${row.id}`)}
          >
            {t('backup_restore')}
          </button>
          {canDelete && (
            <button
              type="button"
              onClick={() => deleteBackup(row)}
              disabled={isBulkBusy || busyAction === `delete-${row.id}`}
              style={{
                ...smallActionButtonStyle(isBulkBusy || busyAction === `delete-${row.id}`),
                background: '#FBEAE4',
                color: '#C44D26',
              }}
            >
              {t('backup_delete')}
            </button>
          )}
        </div>
      ),
      width: '260px',
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <PanelCard title={t('backup_actions')}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <PillButton
            label={t('backup_reload')}
            onClick={reloadBackups}
            disabled={busyAction === 'reload'}
          />
          <button
            type="button"
            onClick={createBackup}
            disabled={busyAction === 'create'}
            style={buttonStyle('primary', busyAction === 'create')}
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
              style={buttonStyle('danger', isBulkBusy)}
            >
              {hasSelection
                ? t('backup_delete_selected', { count: selectedRows.length })
                : t('backup_delete_all')}
            </button>
          )}
        </div>
      </PanelCard>

      <PanelCard title={t('backup_available')}>
        <div
          style={{
            display: 'flex',
            gap: 8,
            flexWrap: 'wrap',
            alignItems: 'center',
            marginBottom: 12,
          }}
        >
          <label
            htmlFor="backup-project-filter"
            style={{
              fontSize: 11,
              letterSpacing: '.06em',
              textTransform: 'uppercase',
              color: '#8B8383',
              fontWeight: 500,
            }}
          >
            {t('backup_filter_project')}
          </label>
          <select
            id="backup-project-filter"
            className="form-select form-select-sm"
            style={{ width: 'auto', minWidth: 220, maxWidth: '100%' }}
            value={projectFilter}
            onChange={(event) => changeProjectFilter(event.target.value)}
          >
            <option value="">{t('backup_project_all')}</option>
            {projects.map((option) => (
              <option key={option.database} value={filterValueOf(option.project)}>
                {projectLabel(t, option.project, option.name, option.database)}
              </option>
            ))}
            {/* A filter from the URL whose database is gone still shows. */}
            {projectFilter && !selectedProject && (
              <option value={projectFilter}>{projectFilter}</option>
            )}
          </select>
        </div>
        <DataTable
          columns={columns}
          data={backups}
          pagination
          progressPending={loading}
          highlightOnHover
          dense
          // Row selection only feeds "delete selected".
          selectableRows={canDelete}
          onSelectedRowsChange={({ selectedRows: rows }) => setSelectedRows(rows)}
          clearSelectedRows={clearSelectionToggle}
          noDataComponent={
            <div style={{ padding: '22px 0', color: '#8B8383', fontSize: 13 }}>
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
            <ul
              style={{
                maxHeight: 160,
                overflowY: 'auto',
                margin: '10px 0 0',
                padding: '0 0 0 18px',
                fontSize: 12.5,
              }}
            >
              {(hasSelection ? selectedRows : backups).map((backup) => (
                <li key={backup.id}>{backup.name}</li>
              ))}
            </ul>
          </div>
        }
        confirmLabel={t('backup_confirm_yes')}
        cancelLabel={t('backup_confirm_cancel')}
        onConfirm={hasSelection ? confirmDeleteSelectedBackups : confirmDeleteAllBackups}
        onCancel={() => setConfirmOpen(false)}
        confirming={isBulkBusy}
      />
    </div>
  );
};

export default BackupView;
