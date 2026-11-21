import { useEffect, useState } from 'react';
import { useSnackbar } from 'notistack';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig';
import { showRequestError } from '../components/ui/Snackbar.jsx';
import type { ArchiveDialogState } from './AnalyseActions';
import type { ProfileRange } from './NoiseProfilePanel';

/** The request's params: the span, of the shown device or (`allDevices`,
 * or none shown) of every device of the location; null without a span. */
export const archiveParamsOf = (
  range: ProfileRange | null,
  allDevices: boolean,
  shownDevice: number | null,
): Record<string, string> | null =>
  range
    ? {
        from: new Date(range.from).toISOString(),
        to: new Date(range.to).toISOString(),
        ...(allDevices || shownDevice == null
          ? {}
          : { device: String(shownDevice) }),
      }
    : null;

/**
 * Staff: the measurements of the picked span (S + drag, the band under the
 * frame slider) archived - only staff see them then
 * (ProgeoMeasurement.archived) - or restored. Of the shown device or of
 * every device of the location. `onArchived`: load everything again.
 */
const useAnalyseArchive = ({
  locationId,
  profileRange,
  shownDevice,
  onArchived,
}: {
  locationId: number;
  profileRange: ProfileRange | null;
  shownDevice: number | null;
  onArchived: () => void;
}) => {
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const { t } = useTranslation();
  const [archiveDialog, setArchiveDialog] = useState<ArchiveDialogState | null>(
    null,
  );
  const [archiveCounts, setArchiveCounts] = useState<{
    key: string;
    total: number;
    archived: number;
  } | null>(null);
  const [archiving, setArchiving] = useState(false);
  const params = archiveDialog
    ? archiveParamsOf(profileRange, archiveDialog.allDevices, shownDevice)
    : null;
  const archiveKey = params ? new URLSearchParams(params).toString() : null;

  // How many measurements the dialog's choice covers.
  useEffect(() => {
    if (!archiveKey) {
      return;
    }
    void axiosConfig.perform_get(
      auth,
      `/v1/location/${locationId}/measurements/archive/?${archiveKey}`,
      (response) =>
        setArchiveCounts({
          key: archiveKey,
          total: Number(response?.data?.total ?? 0),
          archived: Number(response?.data?.archived ?? 0),
        }),
      (error) =>
        showRequestError(enqueueSnackbar, t('analyse_archive_error'), error),
    );
  }, [archiveKey, auth, enqueueSnackbar, locationId, t]);

  const applyArchive = () => {
    if (!archiveDialog || !params) {
      return;
    }
    const { archive } = archiveDialog;
    setArchiving(true);
    void axiosConfig.perform_post(
      auth,
      `/v1/location/${locationId}/measurements/archive/`,
      { ...params, archived: archive },
      (response: { data?: { changed?: number } }) => {
        setArchiving(false);
        setArchiveDialog(null);
        setArchiveCounts(null);
        enqueueSnackbar(
          t(archive ? 'analyse_archive_done' : 'analyse_archive_restored', {
            count: response?.data?.changed ?? 0,
          }),
          { variant: 'success' },
        );
        onArchived();
      },
      (error) => {
        setArchiving(false);
        showRequestError(enqueueSnackbar, t('analyse_archive_error'), error);
      },
    );
  };

  return {
    archiveDialog,
    setArchiveDialog,
    archiveCounts: archiveCounts?.key === archiveKey ? archiveCounts : null,
    archiving,
    applyArchive,
  };
};

export default useAnalyseArchive;
