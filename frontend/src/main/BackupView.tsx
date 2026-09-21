import { useCallback, useEffect, useMemo, useState } from 'react';
import DataTable, { type TableColumn } from 'react-data-table-component';
import { useParams } from 'react-router';
import { useSnackbar } from 'notistack';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig';
import { showErrorBar, showSuccessBar } from '../components/ui/Snackbar.jsx';
import PanelCard from '../components/ui/kit/PanelCard';
import PillButton from '../components/ui/kit/PillButton';
import ConfirmDialog from '../components/ui/kit/ConfirmDialog';
import { formatDateTime } from './dateFormat';

type BackupRow = {
  id: number;
  name: string;
  size: string | null;
  is_compressed: boolean;
  created_at: string | null;
};

// Large enough to get every backup in one call (the list is small - one row
// per dump file on disk) so the DataTable can paginate/sort client-side
// instead of round-tripping to the server for every page.
const LIST_QUERY = 'page_size=1000';

// django-dbbackup names files "{databasename}-{datetime}.psql[.gz]" (see
// parse_backups in backup_viewset.py, which already relies on the db_name
// being a literal substring of the filename) - the part before the first
// "-" is the database alias ("default", "main_db", ...), used both to
// display and to filter by database type.
const dbTypeOf = (name: string) => name.split('-')[0] || name;

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

  const [backups, setBackups] = useState<BackupRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [selectedRows, setSelectedRows] = useState<BackupRow[]>([]);
  const [clearSelectionToggle, setClearSelectionToggle] = useState(false);
  const [selectedDbTypes, setSelectedDbTypes] = useState<string[]>([]);

  const hasSelection = selectedRows.length > 0;
  const isBulkBusy = busyAction === 'delete-all' || busyAction === 'delete-selected';

  const availableDbTypes = useMemo(
    () => Array.from(new Set(backups.map((backup) => dbTypeOf(backup.name)))).sort(),
    [backups],
  );

  const filteredBackups = useMemo(() => {
    if (selectedDbTypes.length === 0) {
      return backups;
    }
    return backups.filter((backup) => selectedDbTypes.includes(dbTypeOf(backup.name)));
  }, [backups, selectedDbTypes]);

  const toggleDbTypeFilter = (dbType: string) => {
    setSelectedDbTypes((prev) =>
      prev.includes(dbType) ? prev.filter((value) => value !== dbType) : [...prev, dbType],
    );
  };

  const applyResponse = (response: { data?: { elements?: BackupRow[] } }) => {
    setBackups((response?.data?.elements || []) as BackupRow[]);
  };

  const loadBackups = useCallback(() => {
    setLoading(true);
    void axiosConfig.perform_get(
      auth,
      `/v1/${account}/backup/?${LIST_QUERY}`,
      (response) => {
        applyResponse(response);
        setLoading(false);
      },
      (error) => {
        const reason = error?.response?.data?.reason || error.message;
        showErrorBar(enqueueSnackbar, t('backup_load_error', { reason }));
        setLoading(false);
      },
    );
  }, [auth, account, enqueueSnackbar, t]);

  useEffect(() => {
    loadBackups();
  }, [loadBackups]);

  const runAction = (
    key: string,
    url: string,
    successMessage: string,
    errorMessageKey: string,
  ) => {
    setBusyAction(key);
    void axiosConfig.perform_post(
      auth,
      `${url}${url.includes('?') ? '&' : '?'}${LIST_QUERY}`,
      {},
      (response) => {
        applyResponse(response);
        showSuccessBar(enqueueSnackbar, successMessage);
        setBusyAction(null);
      },
      (error) => {
        const reason = error?.response?.data?.reason || error.message;
        showErrorBar(enqueueSnackbar, t(errorMessageKey, { reason }));
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

  const createBackup = () =>
    runAction(
      'create',
      `/v1/${account}/backup/create/`,
      t('backup_created'),
      'backup_create_error',
    );

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
                const reason = error?.response?.data?.reason || error.message;
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

  const columns: TableColumn<BackupRow>[] = [
    {
      name: t('backup_col_name'),
      selector: (row) => row.name,
      sortable: true,
      grow: 2,
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
            {t('backup_create')}
          </button>
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
        </div>
      </PanelCard>

      <PanelCard title={t('backup_available')}>
        {availableDbTypes.length > 1 && (
          <div
            style={{
              display: 'flex',
              gap: 8,
              flexWrap: 'wrap',
              alignItems: 'center',
              marginBottom: 12,
            }}
          >
            <span
              style={{
                fontSize: 11,
                letterSpacing: '.06em',
                textTransform: 'uppercase',
                color: '#8B8383',
                fontWeight: 500,
              }}
            >
              {t('backup_filter_db_type')}
            </span>
            {availableDbTypes.map((dbType) => (
              <PillButton
                key={dbType}
                label={dbType}
                active={selectedDbTypes.includes(dbType)}
                onClick={() => toggleDbTypeFilter(dbType)}
              />
            ))}
          </div>
        )}
        <DataTable
          columns={columns}
          data={filteredBackups}
          pagination
          progressPending={loading}
          highlightOnHover
          dense
          selectableRows
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
