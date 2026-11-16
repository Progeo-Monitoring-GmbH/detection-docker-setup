import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Form, Spinner, Table } from 'react-bootstrap';
import { ArrowRepeat, Download, FileEarmarkSpreadsheet, ListCheck } from 'react-bootstrap-icons';
import { useSnackbar } from 'notistack';
import type { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig';
import { downloadResponse } from '../helper';
import PillButton from '../components/ui/kit/PillButton';
import CadUploadDropbox, { CadJobView } from '../components/form/CadUploadDropbox';
import type { CadImportJob } from '../components/form/useCadImportJob';
import { errorReason, showRequestError, showSuccessBar } from '../components/ui/Snackbar.jsx';
import { repeatedTestId } from '../testIds';
import './LageplanKlemmliste.css';

type Auth = ReturnType<typeof useAuth>;

/** A MEA document of the location's Airtable project (helper/airtable_documents.py). */
export type MeaDocument = {
  id: string;
  name: string;
  kind: 'dwg' | 'router' | 'klemmliste';
  size: number | null;
  type: string | null;
  created: string | null;
};

/** A row the cad_factory read from the Klemmliste (docker/cad_factory/klemmliste.py). */
type KlemmlisteRow = { sensor: string; mux: number; pin: number; position: number; page: number };

type PreviewEntry = {
  position: number;
  mux: number | null;
  pin: number | null;
  sensor_order: number;
  new: string;
  old?: string | null;
  points?: number;
};

/** klemmliste/apply's answer (helper/klemmliste_names.py). */
type Preview = {
  changes: PreviewEntry[];
  unchanged: PreviewEntry[];
  missing: { position: number; sensor: string; sensor_order: number }[];
  without_name: number[];
  updated?: number;
};

type Device = { id: number; label: string; first_sensor_order?: number | null };

const KIND_LABEL: Record<MeaDocument['kind'], string> = {
  dwg: 'CAD plan',
  router: 'Router data',
  klemmliste: 'Klemmliste',
};

const STATUS_URL = '/v1/status/measure_points';

const formatSize = (size: number | null) => {
  if (size == null) {
    return '';
  }
  return size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`;
};

/** One line of the preview: what happens to a Klemmliste position. */
type PreviewLine = PreviewEntry & { state: 'change' | 'same' | 'missing' };

const previewLines = (preview: Preview): PreviewLine[] =>
  [
    ...preview.changes.map((entry) => ({ ...entry, state: 'change' as const })),
    ...preview.unchanged.map((entry) => ({ ...entry, state: 'same' as const })),
    ...preview.missing.map((entry) => ({
      ...entry,
      mux: null,
      pin: null,
      new: entry.sensor,
      state: 'missing' as const,
    })),
  ].sort((a, b) => a.position - b.position);

/**
 * Lageplan wizard, step 7: the location's MEA documents from Airtable (staff -
 * CAD plan, Router_Daten.txt, Klemmliste PDF, each downloadable) and the
 * Klemmliste: read by progeo-cad_factory (uploaded or straight from Airtable),
 * its sensor names - position (MUX - 1) * 16 + PIN - previewed against the
 * measure points and written onto them.
 */
const LageplanKlemmliste = ({
  auth,
  locationId,
  devices,
  staff,
  onNamesApplied,
}: {
  auth: Auth;
  /** The selected location's project id (measure_points' location_id). */
  locationId: number;
  devices: Device[];
  /** Airtable is staff only. */
  staff: boolean;
  /** Names were written: the wizard reloads its measure points. */
  onNamesApplied: () => void;
}) => {
  const { enqueueSnackbar } = useSnackbar();
  const [documents, setDocuments] = useState<MeaDocument[] | null>(null);
  const [projectFound, setProjectFound] = useState(true);
  const [documentsError, setDocumentsError] = useState<string | null>(null);
  // The first load starts with the step (one step per location - the wizard keys it).
  const [loadingDocuments, setLoadingDocuments] = useState(staff);
  const [downloading, setDownloading] = useState<string | null>(null);
  // A Klemmliste read from Airtable: its job, followed like an upload.
  const [airtableJob, setAirtableJob] = useState<{ id: string; name: string } | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  // The finished Klemmliste job (upload or Airtable).
  const [job, setJob] = useState<{ id: string; name: string; rows: KlemmlisteRow[]; warnings: string[] } | null>(null);
  const [deviceId, setDeviceId] = useState<number | ''>('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [applying, setApplying] = useState(false);

  /** GET airtable_documents - `loadingDocuments` is switched on by the caller. */
  const fetchDocuments = useCallback(
    (refresh = false) => {
      if (!staff) {
        return;
      }
      void axiosConfig.perform_get(
        auth,
        `${STATUS_URL}/airtable_documents/?location_id=${locationId}${refresh ? '&refresh=1' : ''}`,
        (response) => {
          setDocuments((response?.data?.documents ?? []) as MeaDocument[]);
          setProjectFound(response?.data?.project_found !== false);
          setDocumentsError(null);
          setLoadingDocuments(false);
        },
        (error) => {
          setDocuments([]);
          setDocumentsError(errorReason(error) || 'Airtable could not be read');
          setLoadingDocuments(false);
        },
      );
    },
    [auth, locationId, staff],
  );

  useEffect(() => {
    fetchDocuments();
  }, [fetchDocuments]);

  const refreshDocuments = () => {
    setLoadingDocuments(true);
    fetchDocuments(true);
  };

  const download = async (document: MeaDocument) => {
    setDownloading(document.id);
    await downloadResponse(
      auth,
      `${STATUS_URL}/airtable_documents/download/?location_id=${locationId}&document=${encodeURIComponent(document.id)}`,
      document.name,
    );
    setDownloading(null);
  };

  const readFromAirtable = (document: MeaDocument) => {
    setStarting(document.id);
    void axiosConfig.perform_post(
      auth,
      `${STATUS_URL}/klemmliste/`,
      { location_id: locationId, document: document.id },
      (response) => {
        setStarting(null);
        setJob(null);
        setPreview(null);
        setAirtableJob({ id: String(response?.data?.job_id), name: document.name });
      },
      (error) => {
        setStarting(null);
        showRequestError(enqueueSnackbar, 'The Klemmliste could not be fetched from Airtable', error);
      },
    );
  };

  /** klemmliste/apply of job `jobId` - dry_run: only the preview. */
  const post = (
    jobId: string,
    device: number | '',
    dryRun: boolean,
    onDone: (result: Preview) => void,
    onFail: (error: unknown) => void,
  ) => {
    void axiosConfig.perform_post(
      auth,
      `${STATUS_URL}/klemmliste/apply/`,
      { location_id: locationId, job_id: jobId, device_id: device === '' ? null : device, dry_run: dryRun },
      (response) => onDone(response?.data?.result as Preview),
      onFail,
    );
  };

  /** What applying would change - after reading the list and when another device is picked. */
  const loadPreview = (jobId: string, device: number | '') => {
    setPreviewing(true);
    setPreview(null);
    post(
      jobId,
      device,
      true,
      (result) => {
        setPreview(result);
        setPreviewing(false);
      },
      (error) => {
        setPreviewing(false);
        showRequestError(enqueueSnackbar, 'The Klemmliste could not be compared with the measure points', error);
      },
    );
  };

  const jobFinished = (finished: CadImportJob | undefined, result: unknown) => {
    const data = (result ?? {}) as { rows?: KlemmlisteRow[]; warnings?: string[] };
    if (!finished || finished.status !== 'done' || !Array.isArray(data.rows)) {
      return;
    }
    setJob({
      id: finished.job_id,
      name: finished.source_name ?? 'Klemmliste',
      rows: data.rows,
      warnings: Array.isArray(data.warnings) ? data.warnings : [],
    });
    loadPreview(finished.job_id, deviceId);
  };

  const pickDevice = (device: number | '') => {
    setDeviceId(device);
    if (job) {
      loadPreview(job.id, device);
    }
  };

  const apply = () => {
    if (!job) {
      return;
    }
    setApplying(true);
    post(
      job.id,
      deviceId,
      false,
      (result) => {
        setApplying(false);
        setPreview({ ...result, changes: [], unchanged: [...result.unchanged, ...result.changes] });
        showSuccessBar(enqueueSnackbar, `${result.updated ?? 0} measure point(s) renamed from the Klemmliste`);
        onNamesApplied();
      },
      (error) => {
        setApplying(false);
        showRequestError(enqueueSnackbar, 'The names could not be written', error);
      },
    );
  };

  const lines = useMemo(() => (preview ? previewLines(preview) : []), [preview]);

  const documentsPanel = staff && (
    <div className="lageplan-klemmliste-section" data-testid="lageplan-wizard-mea-documents">
      <div className="lageplan-klemmliste-section-head">
        <span className="lageplan-klemmliste-section-title">MEA documents (Airtable)</span>
        <PillButton
          variant="ghost"
          icon={loadingDocuments ? <Spinner animation="border" size="sm" /> : <ArrowRepeat size={13} />}
          label="Refresh"
          onClick={refreshDocuments}
          disabled={loadingDocuments}
          testId="lageplan-wizard-mea-refresh"
        />
      </div>
      {documentsError ? (
        <div className="lageplan-klemmliste-note lageplan-klemmliste-note--danger" data-testid="lageplan-wizard-mea-error">
          {documentsError}
        </div>
      ) : documents === null || (loadingDocuments && !documents.length) ? (
        <div className="lageplan-klemmliste-note">
          <Spinner animation="border" size="sm" className="me-2" />
          Loading the documents…
        </div>
      ) : !projectFound ? (
        <div className="lageplan-klemmliste-note" data-testid="lageplan-wizard-mea-no-project">
          No Airtable project for this location (project number or Airtable link).
        </div>
      ) : documents.length === 0 ? (
        <div className="lageplan-klemmliste-note" data-testid="lageplan-wizard-mea-empty">
          No CAD plan, Router_Daten.txt or Klemmliste among the project&apos;s MEA documents.
        </div>
      ) : (
        <ul className="lageplan-klemmliste-documents">
          {documents.map((document) => (
            <li key={document.id} {...repeatedTestId('lageplan-wizard-mea-document', document.id)}>
              <Badge bg="light" text="dark" className="lageplan-klemmliste-kind">
                {KIND_LABEL[document.kind]}
              </Badge>
              <span className="lageplan-klemmliste-name" title={document.name}>
                {document.name}
              </span>
              <span className="lageplan-klemmliste-muted">{formatSize(document.size)}</span>
              <span className="lageplan-klemmliste-actions">
                {document.kind === 'klemmliste' && (
                  <PillButton
                    icon={starting === document.id ? <Spinner animation="border" size="sm" /> : <ListCheck size={13} />}
                    label="Read names"
                    onClick={() => readFromAirtable(document)}
                    disabled={starting !== null}
                    testId="lageplan-wizard-mea-read"
                    testKey={document.id}
                  />
                )}
                <PillButton
                  variant="ghost"
                  icon={downloading === document.id ? <Spinner animation="border" size="sm" /> : <Download size={13} />}
                  label="Download"
                  onClick={() => void download(document)}
                  disabled={downloading !== null}
                  testId="lageplan-wizard-mea-download"
                  testKey={document.id}
                />
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  return (
    <div className="lageplan-klemmliste" data-testid="lageplan-wizard-klemmliste">
      {documentsPanel}

      <div className="lageplan-klemmliste-section">
        <div className="lageplan-klemmliste-section-head">
          <span className="lageplan-klemmliste-section-title">
            <FileEarmarkSpreadsheet size={14} className="me-1" />
            Klemmliste: sensor names
          </span>
        </div>
        <div className="lageplan-klemmliste-note">
          The columns Sensor, MUX Karte and PIN name every measure point: position (MUX - 1) × 16 + PIN is
          its sensor number. Nothing is written before you apply it.
        </div>
        <CadUploadDropbox
          auth={auth}
          url={`${STATUS_URL}/klemmliste/`}
          accept="pdf"
          testId="lageplan-wizard-klemmliste-upload"
          maxSizeMB={50}
          hint="Drop a Klemmliste PDF here, or click to choose"
          instantFileUpload={true}
          withPreview={false}
          payload={{ location_id: locationId }}
          callBackProcessing={(result: unknown, finished?: CadImportJob) => jobFinished(finished, result)}
        />
        {airtableJob && (
          <CadJobView
            auth={auth}
            jobId={airtableJob.id}
            name={airtableJob.name}
            compact={false}
            onFinished={(finished) => {
              if (finished.status === 'failed') {
                enqueueSnackbar(`The Klemmliste could not be read: ${finished.error || 'unknown error'}`, {
                  variant: 'error',
                });
              }
              jobFinished(finished, finished.result);
            }}
            testId="lageplan-wizard-klemmliste-airtable-job"
          />
        )}

        {job && (
          <div className="lageplan-klemmliste-result" data-testid="lageplan-wizard-klemmliste-result">
            <div className="lageplan-klemmliste-result-head">
              <span>
                <strong>{job.rows.length}</strong> sensor name(s) from {job.name}
              </span>
              {devices.length > 1 && (
                <Form.Select
                  size="sm"
                  className="lageplan-klemmliste-device"
                  value={deviceId}
                  onChange={(event) => pickDevice(event.target.value === '' ? '' : Number(event.target.value))}
                  aria-label="Device of the Klemmliste"
                  data-testid="lageplan-wizard-klemmliste-device"
                >
                  <option value="">Positions are the sensor numbers of the location</option>
                  {devices.map((device) => (
                    <option key={device.id} value={device.id}>
                      {device.label} (from sensor {device.first_sensor_order ?? 1})
                    </option>
                  ))}
                </Form.Select>
              )}
              <PillButton
                icon={applying ? <Spinner animation="border" size="sm" /> : <ListCheck size={13} />}
                label={`Apply ${preview?.changes.length ?? 0} name(s)`}
                onClick={apply}
                disabled={applying || previewing || !preview || preview.changes.length === 0}
                testId="lageplan-wizard-klemmliste-apply"
              />
            </div>
            {job.warnings.length > 0 && (
              <ul className="lageplan-klemmliste-warnings" data-testid="lageplan-wizard-klemmliste-warnings">
                {job.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            )}
            {preview && preview.without_name.length > 0 && (
              <div className="lageplan-klemmliste-note" data-testid="lageplan-wizard-klemmliste-unnamed">
                Measure points the Klemmliste does not name: {preview.without_name.join(', ')}
              </div>
            )}
            {previewing && !preview ? (
              <div className="lageplan-klemmliste-note">
                <Spinner animation="border" size="sm" className="me-2" />
                Comparing with the measure points…
              </div>
            ) : (
              <div className="lageplan-klemmliste-table">
                <Table size="sm" className="mb-0">
                  <thead>
                    <tr>
                      <th>Position</th>
                      <th>MUX / PIN</th>
                      <th>Sensor</th>
                      <th>Measure point</th>
                      <th>Now</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((line) => (
                      <tr
                        key={line.position}
                        className={`lageplan-klemmliste-line lageplan-klemmliste-line--${line.state}`}
                        {...repeatedTestId('lageplan-wizard-klemmliste-line', line.position)}
                      >
                        <td>{line.position}</td>
                        <td>{line.mux != null ? `${line.mux} / ${line.pin}` : '–'}</td>
                        <td>{line.new}</td>
                        <td>{line.state === 'missing' ? `#${line.sensor_order} – none` : `#${line.sensor_order}`}</td>
                        <td>
                          {line.state === 'change' && <span>{line.old || '(no name)'} → {line.new}</span>}
                          {line.state === 'same' && <span className="lageplan-klemmliste-muted">unchanged</span>}
                          {line.state === 'missing' && (
                            <span className="lageplan-klemmliste-muted">no measure point</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default LageplanKlemmliste;
