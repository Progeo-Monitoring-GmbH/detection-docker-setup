import { Form, Spinner } from 'react-bootstrap';
import { Archive } from 'react-bootstrap-icons';
import { useTranslation } from 'react-i18next';
import ConfirmDialog from '../components/ui/kit/ConfirmDialog';
import { formatDate } from './dateFormat';
import type { ProfileRange } from './NoiseProfilePanel';

export type ArchiveDialogState = {
  allDevices: boolean;
  archive: boolean;
};

type AnalyseActionsProps = {
  offerNoiseProfiles: boolean;
  exportMessage: string | null;
  exportingPdf: boolean;
  onExportCsv: () => void;
  onExportRawCsv: () => void;
  onExportPdf: () => void;
  onOpenArchive: () => void;
  profileRange: ProfileRange | null;
  confirmDisable: boolean;
  onConfirmDisableChange: (show: boolean) => void;
  selectedEnabled: number[];
  switchingSensors: boolean;
  onSwitchSensors: (disabled: boolean) => void;
  archiveDialog: ArchiveDialogState | null;
  onArchiveDialogChange: (state: ArchiveDialogState | null) => void;
  archiveCounts: { total: number; archived: number } | null;
  shownDevice: number | null;
  shownDeviceName: string | null;
  archiving: boolean;
  onApplyArchive: () => void;
};

const AnalyseActions = ({
  offerNoiseProfiles,
  exportMessage,
  exportingPdf,
  onExportCsv,
  onExportRawCsv,
  onExportPdf,
  onOpenArchive,
  profileRange,
  confirmDisable,
  onConfirmDisableChange,
  selectedEnabled,
  switchingSensors,
  onSwitchSensors,
  archiveDialog,
  onArchiveDialogChange,
  archiveCounts,
  shownDevice,
  shownDeviceName,
  archiving,
  onApplyArchive,
}: AnalyseActionsProps) => {
  const { t } = useTranslation();

  return (
    <>
      <div
        className="d-flex flex-wrap align-items-center gap-3"
        data-testid="analyse-toolbar"
      >
        <button
          type="button"
          className="btn btn-outline-secondary btn-sm"
          onClick={onExportCsv}
          data-testid="analyse-export-csv"
        >
          {t('analyse_export_csv')}
        </button>
        {offerNoiseProfiles && (
          <button
            type="button"
            className="btn btn-outline-secondary btn-sm"
            title={t('analyse_export_csv_raw_hint')}
            data-testid="analyse-export-csv-raw"
            onClick={onExportRawCsv}
          >
            {t('analyse_export_csv_raw')}
          </button>
        )}
        <button
          type="button"
          className="btn btn-outline-secondary btn-sm"
          onClick={onExportPdf}
          disabled={exportingPdf}
          data-testid="analyse-export-pdf"
        >
          {exportingPdf && (
            <Spinner size="sm" animation="border" className="me-2" />
          )}
          {t('analyse_export_pdf')}
        </button>
        {offerNoiseProfiles && (
          <button
            type="button"
            className="btn btn-outline-secondary btn-sm d-inline-flex align-items-center gap-1"
            title={
              profileRange
                ? t('analyse_archive_hint')
                : t('analyse_archive_pick_span')
            }
            disabled={!profileRange}
            onClick={onOpenArchive}
            data-testid="analyse-archive"
          >
            <Archive size={13} aria-hidden="true" />
            {t('analyse_archive')}
          </button>
        )}
        {exportMessage && (
          <span
            className="text-success small"
            data-testid="analyse-export-message"
          >
            {exportMessage}
          </span>
        )}
      </div>

      <ConfirmDialog
        testId="analyse-sensor-disable-dialog"
        show={confirmDisable}
        title={t('analyse_sensors_disable_confirm_title')}
        message={t('analyse_sensors_disable_confirm', {
          count: selectedEnabled.length,
          sensors: selectedEnabled.map((pair) => pair + 1).join(', '),
        })}
        confirmLabel={t('analyse_sensors_disable_confirm_button')}
        cancelLabel={t('heat_limit_cancel')}
        onConfirm={() => onSwitchSensors(true)}
        onCancel={() => onConfirmDisableChange(false)}
        confirming={switchingSensors}
        danger
      />

      <ConfirmDialog
        testId="analyse-archive-dialog"
        show={archiveDialog !== null && profileRange !== null}
        title={t('analyse_archive')}
        message={
          archiveDialog && profileRange ? (
            <div className="d-flex flex-column gap-2">
              <div data-testid="analyse-archive-span">
                {t('analyse_archive_span', {
                  from: formatDate(profileRange.from),
                  to: formatDate(profileRange.to),
                })}
              </div>
              <div>
                {shownDevice != null && (
                  <Form.Check
                    type="radio"
                    id="analyse-archive-device"
                    data-testid="analyse-archive-scope-device"
                    name="analyse-archive-scope"
                    label={t('analyse_archive_scope_device', {
                      device: shownDeviceName ?? shownDevice,
                    })}
                    checked={!archiveDialog.allDevices}
                    onChange={() =>
                      onArchiveDialogChange({
                        ...archiveDialog,
                        allDevices: false,
                      })
                    }
                  />
                )}
                <Form.Check
                  type="radio"
                  id="analyse-archive-all"
                  data-testid="analyse-archive-scope-all"
                  name="analyse-archive-scope"
                  label={t('analyse_archive_scope_all')}
                  checked={archiveDialog.allDevices || shownDevice == null}
                  onChange={() =>
                    onArchiveDialogChange({
                      ...archiveDialog,
                      allDevices: true,
                    })
                  }
                />
              </div>
              <div>
                <Form.Check
                  type="radio"
                  id="analyse-archive-archive"
                  data-testid="analyse-archive-action-archive"
                  name="analyse-archive-action"
                  label={t('analyse_archive_action_archive')}
                  checked={archiveDialog.archive}
                  onChange={() =>
                    onArchiveDialogChange({
                      ...archiveDialog,
                      archive: true,
                    })
                  }
                />
                <Form.Check
                  type="radio"
                  id="analyse-archive-restore"
                  data-testid="analyse-archive-action-restore"
                  name="analyse-archive-action"
                  label={t('analyse_archive_action_restore')}
                  checked={!archiveDialog.archive}
                  onChange={() =>
                    onArchiveDialogChange({
                      ...archiveDialog,
                      archive: false,
                    })
                  }
                />
              </div>
              <div
                className="fw-semibold analyse-archive-counts"
                data-testid="analyse-archive-counts"
              >
                {archiveCounts ? (
                  t('analyse_archive_counts', {
                    total: archiveCounts.total,
                    archived: archiveCounts.archived,
                  })
                ) : (
                  <Spinner
                    size="sm"
                    animation="border"
                    className="text-muted"
                  />
                )}
              </div>
              <div data-testid="analyse-archive-effect">
                {t(
                  archiveDialog.archive
                    ? 'analyse_archive_effect_archive'
                    : 'analyse_archive_effect_restore',
                )}
              </div>
            </div>
          ) : null
        }
        confirmLabel={
          archiveDialog?.archive === false
            ? t('analyse_archive_restore')
            : t('analyse_archive_confirm')
        }
        cancelLabel={t('location_edit_cancel')}
        danger={archiveDialog?.archive !== false}
        confirming={archiving}
        onCancel={() => onArchiveDialogChange(null)}
        onConfirm={onApplyArchive}
      />
    </>
  );
};

export default AnalyseActions;
