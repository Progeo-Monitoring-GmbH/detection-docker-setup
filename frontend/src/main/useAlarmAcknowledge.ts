import { useState } from 'react';
import { useSnackbar } from 'notistack';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig';
import { showRequestError } from '../components/ui/Snackbar.jsx';

type Acknowledgeable = { id: string; pending_ack_alarm_ids: ReadonlyArray<number | string> };

/**
 * Acknowledging a suspected leak (Verdachtsstelle) or a computed point:
 * every pending alarm of it, one request each; `acknowledging` holds the
 * ids in progress (their buttons spin), `onDone` reloads the list after.
 */
const useAlarmAcknowledge = (locationId: number, onDone: () => void) => {
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const [acknowledging, setAcknowledging] = useState<Set<string>>(new Set());

  const acknowledge = (item: Acknowledgeable) => {
    if (item.pending_ack_alarm_ids.length === 0) {
      return;
    }
    setAcknowledging((prev) => new Set(prev).add(item.id));
    Promise.all(
      item.pending_ack_alarm_ids.map(
        (alarmId) =>
          new Promise<void>((resolve) => {
            void axiosConfig.perform_post(
              auth,
              // ?location=: alarm ids are only unique within one project database.
              `/v1/alarm/${alarmId}/acknowledge/?location=${locationId}`,
              {},
              () => resolve(),
              (error) => {
                showRequestError(enqueueSnackbar, 'Could not acknowledge alarm', error);
                resolve();
              },
            );
          }),
      ),
    ).then(() => {
      setAcknowledging((prev) => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
      onDone();
    });
  };

  return { acknowledging, acknowledge };
};

export default useAlarmAcknowledge;
