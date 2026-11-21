import { useEffect, useState } from 'react';
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
import { selectedLocationLabel, type SelectedLocation } from './locationSelection';
import './LocationSelection.css';

/** Answer of GET /v1/location-selection/project-id/ - never names who uses a number. */
type ProjectIdCheck = {
  nr: number | null;
  free: boolean | null;
  suggestion: number;
};

/**
 * "Merge projects" of the location overview (backend helper/location_merge.py):
 * a new project number becomes a merged project the selected locations are
 * parts of. Nothing is moved - the devices go on sending their old numbers
 * to their locations; the portal shows the parts' lageplans as one object.
 */
const MergeProjectsModal = ({
  locations,
  onHide,
  onDone,
}: {
  locations: SelectedLocation[];
  onHide: () => void;
  /** The merged project's location id. */
  onDone: (parentId: number) => void;
}) => {
  const auth = useAuth();
  const { t } = useTranslation();
  const { enqueueSnackbar } = useSnackbar();
  const [nr, setNr] = useState('');
  const [name, setName] = useState(locations[0]?.name ?? '');
  const [check, setCheck] = useState<ProjectIdCheck | null>(null);
  // The answer is for another number (still typing / asking): not known yet.
  const wellFormed = /^\d+$/.test(nr);
  const checking = wellFormed && check?.nr !== Number(nr);
  const [saving, setSaving] = useState(false);

  // The next free number as the proposal - once.
  useEffect(() => {
    void axiosConfig.perform_get(
      auth,
      '/v1/location-selection/project-id/',
      (response) => {
        const suggestion = (response?.data as ProjectIdCheck | undefined)
          ?.suggestion;
        if (suggestion != null) {
          setNr((current) => current || String(suggestion));
        }
      },
    );
  }, [auth]);

  // Is the typed number free? Asked a moment after the last keystroke.
  useEffect(() => {
    if (!wellFormed) {
      return undefined;
    }
    const timer = window.setTimeout(() => {
      void axiosConfig.perform_get(
        auth,
        `/v1/location-selection/project-id/?nr=${nr}`,
        (response) => setCheck(response?.data as ProjectIdCheck),
        () => setCheck({ nr: Number(nr), free: null, suggestion: 0 }),
      );
    }, 350);
    return () => window.clearTimeout(timer);
  }, [auth, nr, wellFormed]);

  const free = check?.nr === Number(nr) && check.free === true;

  const submit = () => {
    setSaving(true);
    void axiosConfig.perform_post(
      auth,
      '/v1/location-selection/merge/',
      {
        ids: locations.map((location) => location.id),
        project_id: Number(nr),
        name: name.trim(),
      },
      (response) => {
        setSaving(false);
        showSuccessBar(
          enqueueSnackbar,
          t('selection_merge_done', { nr, count: locations.length }),
        );
        onDone(Number(response?.data?.location));
      },
      (error) => {
        setSaving(false);
        showRequestError(enqueueSnackbar, t('selection_merge_failed'), error);
      },
    );
  };

  return (
    <Modal show onHide={onHide} centered data-testid="merge-projects-modal">
      <Modal.Header closeButton>
        <Modal.Title className="location-selection-title">
          {t('selection_merge_title')}
        </Modal.Title>
      </Modal.Header>
      <Modal.Body className="location-selection-body">
        <div className="location-selection-hint">
          {t('selection_merge_intro')}
        </div>
        <ul
          className="location-selection-list"
          data-testid="merge-projects-parts"
        >
          {locations.map((location) => (
            <li key={location.id}>{selectedLocationLabel(location)}</li>
          ))}
        </ul>
        <div className="location-selection-names">
          <LabeledInput
            label={t('selection_merge_nr')}
            value={nr}
            onChange={(value) => setNr(value.replace(/\D/g, ''))}
            testId="merge-projects-nr"
          />
          <LabeledInput
            label={t('selection_merge_name')}
            value={name}
            onChange={setName}
            testId="merge-projects-name"
          />
        </div>
        <div
          className="location-selection-nr"
          data-testid="merge-projects-nr-state"
        >
          {checking ? (
            <Spinner animation="border" size="sm" />
          ) : check && check.nr === Number(nr) && check.free !== null ? (
            <span
              className={
                free ? 'location-selection-ok' : 'location-selection-error'
              }
            >
              {t(free ? 'anlegen_nr_free' : 'selection_merge_nr_used')}
            </span>
          ) : null}
        </div>
        <div className="location-selection-hint">
          {t('selection_merge_devices')}
        </div>
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
          disabled={!free || checking || saving}
          data-testid="merge-projects-confirm"
        >
          {saving && <Spinner animation="border" size="sm" />}
          {t('selection_merge_confirm', { count: locations.length })}
        </button>
      </Modal.Footer>
    </Modal>
  );
};

export default MergeProjectsModal;
