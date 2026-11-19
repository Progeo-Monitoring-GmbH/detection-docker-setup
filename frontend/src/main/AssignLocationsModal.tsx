import { useEffect, useMemo, useState } from 'react';
import { Modal, Spinner } from 'react-bootstrap';
import { useTranslation } from 'react-i18next';
import { useSnackbar } from 'notistack';
import { useAuth } from '../../hooks/CoreAuthProvider';
import axiosConfig from '../axiosConfig';
import {
  showRequestError,
  showSuccessBar,
} from '../components/ui/Snackbar.jsx';
import LabeledInput from '../components/ui/kit/LabeledInput';
import SegmentedControl from '../components/ui/kit/SegmentedControl';
import SearchableDataTable, {
  type SearchableColumn,
} from '../components/ui/kit/SearchableDataTable';
import { type SelectedLocation, selectionLabel } from './locationSelection';
import './LocationSelection.css';

/** A row of GET /v1/location-selection/users/: who already has access to one of the locations. */
type AssignUser = { id: number; name: string | null; email: string };

/** Answer of POST /v1/location-selection/assign/ (helper/location_invites.py invite_to_locations). */
type AssignResult = {
  status: 'granted' | 'invited' | 'already' | 'staff';
  granted: number[];
  already: number[];
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * "Assign to user" of the location overview - the Rechte tab's "Add user"
 * for several locations at once: pick someone who already has access to
 * one of them (their account's members and single-access users, never
 * ProGeo staff) or enter an address - an existing account gets access and
 * one mail listing the objects, a new one an invitation.
 */
const AssignLocationsModal = ({
  locations,
  onHide,
  onDone,
}: {
  locations: SelectedLocation[];
  onHide: () => void;
  onDone: () => void;
}) => {
  const auth = useAuth();
  const { t } = useTranslation();
  const { enqueueSnackbar } = useSnackbar();
  const [mode, setMode] = useState<'existing' | 'email'>('existing');
  const [users, setUsers] = useState<AssignUser[] | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [email, setEmail] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [saving, setSaving] = useState(false);
  const ids = locations.map((location) => location.id).join(',');

  useEffect(() => {
    void axiosConfig.perform_get(
      auth,
      `/v1/location-selection/users/?ids=${ids}`,
      (response) => setUsers((response?.data?.users || []) as AssignUser[]),
      (error) => {
        setUsers([]);
        showRequestError(enqueueSnackbar, t('selection_users_failed'), error);
      },
    );
  }, [auth, enqueueSnackbar, ids, t]);

  const columns: SearchableColumn<AssignUser>[] = useMemo(
    () => [
      {
        id: 'name',
        name: t('selection_user_name'),
        selector: (row) => row.name ?? '',
        sortable: true,
      },
      {
        id: 'email',
        name: t('selection_user_email'),
        selector: (row) => row.email,
        sortable: true,
      },
    ],
    [t],
  );

  const pickedId = [...picked][0];
  const valid =
    mode === 'existing' ? pickedId != null : EMAIL.test(email.trim());

  const submit = () => {
    if (!valid) {
      return;
    }
    setSaving(true);
    const body =
      mode === 'existing'
        ? { ids: locations.map((location) => location.id), user_id: pickedId }
        : {
            ids: locations.map((location) => location.id),
            email: email.trim(),
            first_name: firstName.trim(),
            last_name: lastName.trim(),
          };
    void axiosConfig.perform_post(
      auth,
      '/v1/location-selection/assign/',
      body,
      (response) => {
        const result = response?.data as AssignResult;
        setSaving(false);
        showSuccessBar(
          enqueueSnackbar,
          t(`selection_assign_${result?.status ?? 'granted'}`, {
            count: result?.granted?.length ?? 0,
            already: result?.already?.length ?? 0,
          }),
        );
        onDone();
      },
      (error) => {
        setSaving(false);
        showRequestError(enqueueSnackbar, t('selection_assign_failed'), error);
      },
    );
  };

  return (
    <Modal
      show
      onHide={onHide}
      centered
      size="lg"
      data-testid="assign-locations-modal"
    >
      <Modal.Header closeButton>
        <Modal.Title className="location-selection-title">
          {t('selection_assign_title')}
        </Modal.Title>
      </Modal.Header>
      <Modal.Body className="location-selection-body">
        <div
          className="location-selection-targets"
          data-testid="assign-locations-targets"
        >
          {selectionLabel(locations, t)}
        </div>
        <SegmentedControl
          options={[
            { value: 'existing', label: t('selection_assign_existing') },
            { value: 'email', label: t('selection_assign_email') },
          ]}
          value={mode}
          onChange={(value) => setMode(value as 'existing' | 'email')}
          testId="assign-locations-mode"
        />
        {mode === 'existing' ? (
          users === null ? (
            <div className="location-selection-loading">
              <Spinner animation="border" size="sm" />
            </div>
          ) : (
            <SearchableDataTable<AssignUser, number>
              columns={columns}
              data={users}
              dense
              // A pager only for long lists.
              pagination={users.length > 8}
              paginationPerPage={8}
              paginationRowsPerPageOptions={[8]}
              labels={{ placeholder: t('selection_users_search') }}
              noDataComponent={
                <div className="location-selection-empty">
                  {t('selection_users_empty')}
                </div>
              }
              // One person: picking another replaces the pick.
              selection={{
                rowKey: (row) => row.id,
                selected: picked,
                onChange: (next) =>
                  setPicked(
                    new Set(
                      [...next].filter((id) => !picked.has(id)).slice(-1),
                    ),
                  ),
              }}
              testId="assign-locations-users"
            />
          )
        ) : (
          <div className="location-selection-invite">
            <LabeledInput
              label={t('rechte_invite_email')}
              type="email"
              value={email}
              onChange={setEmail}
              testId="assign-locations-email"
            />
            <div className="location-selection-names">
              <LabeledInput
                label={t('rechte_invite_first_name')}
                value={firstName}
                onChange={setFirstName}
              />
              <LabeledInput
                label={t('rechte_invite_last_name')}
                value={lastName}
                onChange={setLastName}
              />
            </div>
            <div className="location-selection-hint">
              {t('rechte_invite_hint')}
            </div>
          </div>
        )}
      </Modal.Body>
      <Modal.Footer>
        <button
          type="button"
          className="location-selection-cancel"
          onClick={onHide}
        >
          {t('rechte_cancel')}
        </button>
        <button
          type="button"
          className="location-selection-confirm"
          onClick={submit}
          disabled={!valid || saving}
          data-testid="assign-locations-confirm"
        >
          {saving && <Spinner animation="border" size="sm" />}
          {t('selection_assign_confirm', { count: locations.length })}
        </button>
      </Modal.Footer>
    </Modal>
  );
};

export default AssignLocationsModal;
