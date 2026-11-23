import { useEffect, useRef, useState } from 'react';
import { Form, Modal, ProgressBar, Spinner } from 'react-bootstrap';
import { useTranslation } from 'react-i18next';
import { useSnackbar } from 'notistack';
import { useAuth } from '../../hooks/CoreAuthProvider';
import axiosConfig from '../axiosConfig';
import {
  showRequestError,
  showSuccessBar,
} from '../components/ui/Snackbar.jsx';
import LabeledInput from '../components/ui/kit/LabeledInput';
import { repeatedTestId } from '../testIds';
import {
  mergeMainDefault,
  selectedLocationLabel,
  type SelectedLocation,
} from './locationSelection';
import './LocationSelection.css';

/** Answer of GET /v1/location-selection/project-id/ - never names who uses a number. */
type ProjectIdCheck = {
  nr: number | null;
  free: boolean | null;
  suggestion: number;
};

/** GET /v1/location-selection/merge-job/ (helper/location_merge.py run_job). */
export type MergeJob = {
  status: 'queued' | 'running' | 'done' | 'incomplete' | 'failed';
  main: number;
  project_id: number | null;
  parts: number[];
  progress?: {
    step?: string;
    part_index?: number;
    parts?: number;
    device?: string;
    device_index?: number;
    devices?: number;
  };
  error?: string;
  /** Still queued long after it was started: no background worker took it. */
  stale?: boolean;
};

/** The main project picked: one of the selected locations, or a new project number. */
type MainChoice = number | 'new';

const POLL_MS = 2000;

/** How far the job is (0-100): the parts done, the current part's devices. */
export const mergeProgress = (job: MergeJob | null) => {
  if (!job || job.status === 'queued') {
    return 0;
  }
  if (job.status !== 'running') {
    return 100;
  }
  const progress = job.progress ?? {};
  const parts = Math.max(progress.parts ?? 1, 1);
  const devices = Math.max(progress.devices ?? 1, 1);
  const inPart =
    progress.step === 'plans' ? 1 : (progress.device_index ?? 0) / devices;
  return Math.round((((progress.part_index ?? 0) + inPart) / parts) * 100);
};

/**
 * "Merge projects" of the location overview (backend helper/location_merge.py):
 * the devices of the selected projects move - with their measurements and
 * alarms - into a main project, one of them or a new one; plans, measure
 * points and users go along, the sensor numbers behind the main project's.
 * The other projects are hidden afterwards. Moving runs as a background job:
 * the dialog follows it and may be closed meanwhile.
 */
const MergeProjectsModal = ({
  locations,
  onHide,
  onDone,
}: {
  locations: SelectedLocation[];
  onHide: () => void;
  /** The main project's location id. */
  onDone: (mainId: number) => void;
}) => {
  const auth = useAuth();
  const { t } = useTranslation();
  const { enqueueSnackbar } = useSnackbar();
  const [main, setMain] = useState<MainChoice>(() => mergeMainDefault(locations));
  const [nr, setNr] = useState('');
  const [name, setName] = useState(locations[0]?.name ?? '');
  const [check, setCheck] = useState<ProjectIdCheck | null>(null);
  const isNew = main === 'new';
  // The answer is for another number (still typing / asking): not known yet.
  const wellFormed = /^\d+$/.test(nr);
  const checking = isNew && wellFormed && check?.nr !== Number(nr);
  const [saving, setSaving] = useState(false);
  const [job, setJob] = useState<{ id: string; mainId: number; state: MergeJob | null } | null>(null);

  // The next free number as the proposal - once, when a new project is picked.
  useEffect(() => {
    if (!isNew) {
      return;
    }
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
  }, [auth, isNew]);

  // Is the typed number free? Asked a moment after the last keystroke.
  useEffect(() => {
    if (!isNew || !wellFormed) {
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
  }, [auth, isNew, nr, wellFormed]);

  // The running merge: asked again every POLL_MS until it ends.
  const jobId = job?.id;
  const jobStatus = job?.state?.status;
  useEffect(() => {
    if (!jobId || job?.state?.stale || (jobStatus && !['queued', 'running'].includes(jobStatus))) {
      return undefined;
    }
    const timer = window.setTimeout(() => {
      void axiosConfig.perform_get(
        auth,
        `/v1/location-selection/merge-job/?id=${jobId}`,
        (response) => {
          const state = (response?.data?.job ?? null) as MergeJob | null;
          setJob((current) => (current && current.id === jobId ? { ...current, state } : current));
        },
      );
    }, job?.state ? POLL_MS : 0);
    return () => window.clearTimeout(timer);
  }, [auth, job?.state, jobId, jobStatus]);

  // The end of the merge: told once.
  const told = useRef(false);
  useEffect(() => {
    if (!job || !jobStatus || ['queued', 'running'].includes(jobStatus) || told.current) {
      return;
    }
    told.current = true;
    if (jobStatus === 'done') {
      showSuccessBar(
        enqueueSnackbar,
        t('selection_merge_done', { nr: job.state?.project_id ?? '' }),
      );
      onDone(job.mainId);
    }
    // 'incomplete' and 'failed' stay in the dialog (merge_state).
  }, [enqueueSnackbar, job, jobStatus, onDone, t]);

  const free = check?.nr === Number(nr) && check.free === true;
  const ready = isNew ? free && !checking : true;
  const stale = Boolean(job?.state?.stale);
  const running = Boolean(job) && !stale && (!jobStatus || ['queued', 'running'].includes(jobStatus));

  /** Start the merge - again (`retryInto`: the main project of a merge no worker took, a new one exists now). */
  const submit = (retryInto?: number) => {
    setSaving(true);
    told.current = false;
    const ids = locations.map((location) => location.id);
    void axiosConfig.perform_post(
      auth,
      '/v1/location-selection/merge/',
      retryInto != null
        ? { ids: ids.includes(retryInto) ? ids : [...ids, retryInto], main: retryInto }
        : { ids, ...(isNew ? { project_id: Number(nr), name: name.trim() } : { main }) },
      (response) => {
        setSaving(false);
        setJob({
          id: String(response?.data?.job_id),
          mainId: Number(response?.data?.location),
          state: null,
        });
      },
      (error) => {
        setSaving(false);
        showRequestError(enqueueSnackbar, t('selection_merge_failed'), error);
      },
    );
  };

  const progress = job?.state?.progress;
  const progressText =
    job?.state?.status === 'running' && progress?.step === 'device'
      ? t('selection_merge_moving_device', {
          device: progress.device ?? '',
          index: (progress.device_index ?? 0) + 1,
          count: progress.devices ?? 0,
          part: (progress.part_index ?? 0) + 1,
          parts: progress.parts ?? 0,
        })
      : t('selection_merge_running');

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
        <fieldset
          className="location-selection-mains"
          disabled={Boolean(job) || saving}
          data-testid="merge-projects-main"
        >
          <legend className="location-selection-targets">
            {t('selection_merge_main')}
          </legend>
          {locations.map((location) => (
            <Form.Check
              key={location.id}
              type="radio"
              name="merge-main"
              id={`merge-main-${location.id}`}
              checked={main === location.id}
              onChange={() => setMain(location.id)}
              label={<strong>{selectedLocationLabel(location)}</strong>}
              {...repeatedTestId('merge-projects-main-option', location.id)}
            />
          ))}
          <Form.Check
            type="radio"
            name="merge-main"
            id="merge-main-new"
            checked={isNew}
            onChange={() => setMain('new')}
            label={t('selection_merge_main_new')}
            data-testid="merge-projects-main-new"
          />
        </fieldset>
        {isNew && (
          <>
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
          </>
        )}
        <div className="location-selection-hint">
          {t(isNew ? 'selection_merge_main_hint_new' : 'selection_merge_main_hint')}
        </div>
        {job && (
          <div className="location-selection-job" data-testid="merge-projects-job">
            {stale ? (
              <>
                <span className="location-selection-error" data-testid="merge-projects-stale">
                  {t('selection_merge_stale')}
                </span>
                <button
                  type="button"
                  className="location-selection-confirm"
                  onClick={() => submit(job.mainId)}
                  disabled={saving}
                  data-testid="merge-projects-retry"
                >
                  {t('selection_merge_retry')}
                </button>
              </>
            ) : job.state?.status === 'failed' ? (
              <span className="location-selection-error" data-testid="merge-projects-failed">
                {t('selection_merge_job_failed', { reason: job.state.error ?? '' })}
              </span>
            ) : job.state?.status === 'incomplete' ? (
              <span className="location-selection-error" data-testid="merge-projects-incomplete">
                {t('selection_merge_incomplete')}
              </span>
            ) : (
              <>
                <span>{progressText}</span>
                <ProgressBar now={mergeProgress(job.state)} />
                <span className="location-selection-hint">
                  {t('selection_merge_background')}
                </span>
              </>
            )}
          </div>
        )}
      </Modal.Body>
      <Modal.Footer>
        <button
          type="button"
          className="location-selection-cancel"
          onClick={onHide}
        >
          {t(job ? 'selection_merge_close' : 'rechte_cancel')}
        </button>
        {!job && (
          <button
            type="button"
            className="location-selection-confirm"
            onClick={() => submit()}
            disabled={!ready || saving}
            data-testid="merge-projects-confirm"
          >
            {saving && <Spinner animation="border" size="sm" />}
            {t('selection_merge_confirm', { count: locations.length })}
          </button>
        )}
        {running && <Spinner animation="border" size="sm" />}
      </Modal.Footer>
    </Modal>
  );
};

export default MergeProjectsModal;
