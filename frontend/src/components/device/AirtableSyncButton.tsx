import { useState } from 'react';
import { Modal, Spinner } from 'react-bootstrap';
import { ArrowRepeat } from 'react-bootstrap-icons';
import { useSnackbar } from 'notistack';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../../hooks/CoreAuthProvider';
import axiosConfig from '../../axiosConfig';
import { staffFlags } from '../../main/access';
import { showRequestError } from '../ui/Snackbar.jsx';
import PillButton from '../ui/kit/PillButton';
import AirtableSyncPanel, { type AirtableSync } from './AirtableSyncPanel';
import './AirtableSyncButton.css';

/**
 * "Mit Airtable abgleichen" (staff and superusers - the backend's
 * is_staff_admin): syncs the locations with Airtable
 * (/v1/device/provision/airtable/sync/) and shows the result - the projects
 * without a location, to create them - in a dialog (AirtableSyncPanel).
 * Renders nothing for anyone else. On the location overview and the
 * Verwaltung page. `onLocationsChanged`: names changed or locations were
 * created - the page reloads its list.
 */
const AirtableSyncButton = ({ onLocationsChanged }: { onLocationsChanged?: () => void }) => {
  const auth = useAuth();
  const { t } = useTranslation();
  const { enqueueSnackbar } = useSnackbar();
  const [syncing, setSyncing] = useState(false);
  const [result, setResult] = useState<AirtableSync | null>(null);

  if (!staffFlags(auth?.user).isStaffOrSuperuser) {
    return null;
  }

  const sync = () => {
    setSyncing(true);
    void axiosConfig.perform_post(
      auth,
      '/v1/device/provision/airtable/sync/',
      {},
      (response) => {
        const data = (response?.data || null) as AirtableSync | null;
        // Only a complete answer opens the dialog (the panel lists both).
        setResult(Array.isArray(data?.available) && Array.isArray(data?.updated) ? data : null);
        setSyncing(false);
        if (data?.updated?.length) {
          // Names may have changed.
          onLocationsChanged?.();
        }
      },
      (error) => {
        showRequestError(enqueueSnackbar, t('airtable_sync_failed'), error);
        setSyncing(false);
      },
    );
  };

  return (
    <>
      <PillButton
        variant="ghost"
        icon={syncing ? <Spinner animation="border" size="sm" /> : <ArrowRepeat size={14} />}
        label={t('devices_airtable_sync')}
        disabled={syncing}
        onClick={sync}
        testId="airtable-sync-button"
      />
      <Modal
        show={result !== null}
        onHide={() => setResult(null)}
        size="xl"
        fullscreen="md-down"
        dialogClassName="airtable-sync-dialog"
        data-testid="airtable-sync-dialog"
      >
        <Modal.Body className="airtable-sync-dialog-body">
          {result && (
            <AirtableSyncPanel
              // A new sync starts a fresh selection.
              key={result.signed}
              initial={result}
              flat
              onClose={() => setResult(null)}
              onLocationsChanged={() => onLocationsChanged?.()}
            />
          )}
        </Modal.Body>
      </Modal>
    </>
  );
};

export default AirtableSyncButton;
