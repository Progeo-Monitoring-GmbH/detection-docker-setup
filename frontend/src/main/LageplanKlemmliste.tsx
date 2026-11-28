import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Form, Spinner, Table } from 'react-bootstrap';
import { ArrowRepeat, BoxArrowUpRight, Download, FileEarmarkSpreadsheet, ListCheck } from 'react-bootstrap-icons';
import { useSnackbar } from 'notistack';
import type { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig';
import { downloadResponse } from '../helper';
import PillButton from '../components/ui/kit/PillButton';
import CadUploadDropbox, { CadJobView } from '../components/form/CadUploadDropbox';
import type { CadImportJob } from '../components/form/useCadImportJob';
import { errorReason, showRequestError, showSuccessBar } from '../components/ui/Snackbar.jsx';
import { repeatedTestId } from '../testIds';
import { formatDate } from './dateFormat';
import SensorMappingPanel from './SensorMappingPanel';
import './LageplanKlemmliste.css';

type Auth = ReturnType<typeof useAuth>;

/** A document of the location's Airtable project (helper/airtable_documents.py). */
export type MeaDocument = {
  id: string;
  name: string;
  /** "klemmliste": named like one (Klemmliste*, Pin_Assignment*, ...); "pdf": any other PDF - readable too. */
  kind: 'dwg' | 'router' | 'klemmliste' | 'pdf';
  /** Its Dokumententyp: "mea" MEA-Dokumente, "drawings" Zeichnungen (Verlegplan). */
  group?: 'mea' | 'drawings';
  size: number | null;
  type: string | null;
  created: string | null;
  /** Last change of the record's name / type in Airtable ("Name/Typ geändert") - null until it was changed. */
  modified?: string | null;
};

/** A row the cad_factory read from the Klemmliste (docker/cad_factory/klemmliste.py). */
type KlemmlisteRow = {
  sensor: string;
  mux: number;
  pin: number;
  position: number;
  page: number;
  /** The measuring unit (controller) of the row - one list for several devices; MUX counts from 1 per unit. */
  unit?: string | null;
};

/** Per measuring unit: its device and the sensor count check (klemmliste_names._unit_summary). */
type UnitSummary = {
  unit: string;
  rows: number;
  device_id: number | null;
  device_label: string | null;
  first_sensor_order: number | null;
  last_sensor_order?: number | null;
  /** The device's own sensor count (ProgeoDevice.sensor_count), null if unknown. */
  sensor_count: number | null;
  count_matches: boolean | null;
};

type PreviewEntry = {
  position: number;
  mux: number | null;
  pin: number | null;
  /** The sensor number after applying (the input). */
  sensor_order: number;
  /** A move / conflict: the point's number now (its plan label). */
  from_order?: number;
  unit?: string | null;
  new: string;
  old?: string | null;
  points?: number;
};

/** How the list is applied: renumber / name the points, or map the inputs onto them (from now on). */
export type Strategy = 'points' | 'map';

/** Strategy "map": a device's inputs onto the points (helper/klemmliste_names.preview_map). */
type MappingPreview = {
  unit: string | null;
  device_id: number;
  device_label: string;
  positions: {
    position: number;
    mux: number | null;
    pin: number | null;
    sensor: string;
    sensor_order: number;
    formula: number;
    current: number | null;
  }[];
  /** Inputs whose sensor differs from first sensor + input - 1. */
  remapped: number;
  /** Inputs whose sensor differs from what is valid now. */
  changed: number;
  unmapped_inputs: number[];
  manual_conflicts: { position: number; klemmliste: number | null; manual: number | null }[];
};

/** klemmliste/apply's answer (helper/klemmliste_names.py). */
type Preview = {
  strategy?: Strategy;
  /** "map" once the location has measurements - renumbering would change what they meant. */
  suggested_strategy?: Strategy;
  mappings?: MappingPreview[];
  /** "renumber": the points are numbered by their plan label and move to their input. */
  mode?: 'name' | 'renumber' | 'map';
  moves?: PreviewEntry[];
  conflicts?: { position: number; mux?: number | null; pin?: number | null; sensor: string;
    sensor_order: number; from_order: number; unit?: string | null }[];
  changes: PreviewEntry[];
  unchanged: PreviewEntry[];
  missing: { position: number; mux?: number | null; pin?: number | null; sensor: string; sensor_order: number;
    unit?: string | null }[];
  /** A list for several controllers: its measuring units and their devices. */
  units?: UnitSummary[];
  unit_warnings?: string[];
  /** Rows of a unit without device - left out. */
  unassigned?: number;
  /** What applying changes on the devices: [now, new] first sensor number and sensor count. */
  device_updates?: {
    unit: string;
    device_id: number;
    device_label: string;
    first_sensor_order: [number, number];
    sensor_count: [number | null, number];
  }[];
  /** The list's sensors - compared with the location's measure points (point_orders.count). */
  rows_total?: number;
  without_name: number[];
  /** The location's measure points: how many, lowest and highest sensor number. */
  point_orders?: { count: number; min: number | null; max: number | null };
  /** Missing rows whose sensor name ends in an existing point's number ("D_124" - point 124). */
  named_like_points?: number;
  updated?: number;
};

type Device = { id: number; label: string; first_sensor_order?: number | null };

const KIND_LABEL: Record<MeaDocument['kind'], string> = {
  dwg: 'CAD plan',
  router: 'Router data',
  klemmliste: 'Klemmliste',
  pdf: 'PDF',
};

/** The document groups (Dokumententyp in Airtable), in the backend's order. */
const GROUPS: { group: NonNullable<MeaDocument['group']>; label: string }[] = [
  { group: 'mea', label: 'MEA-Dokumente' },
  { group: 'drawings', label: 'Zeichnungen (Verlegplan)' },
];

const groupOf = (document: MeaDocument) => document.group ?? 'mea';

/** The sensor names of any MEA PDF can be read - a Klemmliste isn't always named so;
 * of the drawings only one named like a Klemmliste (a Verlegplan PDF is none). */
const readable = (document: MeaDocument) =>
  document.kind === 'klemmliste' || (document.kind === 'pdf' && groupOf(document) === 'mea');

const STATUS_URL = '/v1/status/measure_points';

const formatSize = (size: number | null) => {
  if (size == null) {
    return '';
  }
  return size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`;
};

/** One line of the preview: what happens to a Klemmliste position. */
type PreviewLine = PreviewEntry & { state: 'move' | 'change' | 'same' | 'missing' | 'conflict' };

/** What applying writes: the device updates, the moves and the name changes. */
export const pendingCount = (preview: Preview | null) =>
  preview
    ? (preview.device_updates?.length ?? 0) +
      (preview.moves?.length ?? 0) +
      preview.changes.length +
      (preview.mappings ?? []).reduce((sum, mapping) => sum + mapping.changed, 0)
    : 0;

const previewLines = (preview: Preview): PreviewLine[] =>
  [
    ...(preview.moves ?? []).map((entry) => ({ ...entry, state: 'move' as const })),
    ...(preview.conflicts ?? []).map((entry) => ({
      ...entry,
      mux: entry.mux ?? null,
      pin: entry.pin ?? null,
      new: entry.sensor,
      state: 'conflict' as const,
    })),
    ...preview.changes.map((entry) => ({ ...entry, state: 'change' as const })),
    ...preview.unchanged.map((entry) => ({ ...entry, state: 'same' as const })),
    ...preview.missing.map((entry) => ({
      ...entry,
      mux: entry.mux ?? null,
      pin: entry.pin ?? null,
      new: entry.sensor,
      state: 'missing' as const,
    })),
  // In the list's order: by unit (as they come), then by position.
  ].sort((a, b) => {
    const units = (preview.units ?? []).map((unit) => unit.unit);
    const unitOrder = (line: { unit?: string | null }) => (line.unit ? units.indexOf(line.unit) : -1);
    return unitOrder(a) - unitOrder(b) || a.position - b.position;
  });

/** The key of a preview line: positions repeat in every unit. */
const lineKey = (line: { unit?: string | null; position: number }) =>
  line.unit ? `${line.unit}-${line.position}` : String(line.position);

/**
 * Lageplan wizard, step 7: the location's MEA documents and drawings
 * (Zeichnungen (Verlegplan)) from Airtable (staff - CAD plans, Router_Daten.txt
 * and every PDF, a recognised Klemmliste first, each downloadable; any MEA PDF
 * can be read as Klemmliste; a link opens the project in Airtable) and the
 * Klemmliste: read by progeo-cad_factory (uploaded or straight from Airtable),
 * its sensor names - position (MUX - 1) * 16 + PIN - previewed against the
 * measure points and written onto them.
 * The documents can come from another Airtable project ("Project number"):
 * a merged project needs the Klemmlisten of the projects its devices come
 * from - the names still go onto the selected location's points.
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
  // The project in Airtable (the location's Airtable link, else the project's own).
  const [projectUrl, setProjectUrl] = useState<string | null>(null);
  const [documentsError, setDocumentsError] = useState<string | null>(null);
  // Another Airtable project to read the documents of ('' = the location's own) - and the field's text.
  const [projectNumber, setProjectNumber] = useState('');
  const [projectInput, setProjectInput] = useState('');
  const projectQuery = projectNumber ? `&project_number=${encodeURIComponent(projectNumber)}` : '';
  // The first load starts with the step (one step per location - the wizard keys it).
  const [loadingDocuments, setLoadingDocuments] = useState(staff);
  const [downloading, setDownloading] = useState<string | null>(null);
  // A Klemmliste read from Airtable: its job, followed like an upload.
  const [airtableJob, setAirtableJob] = useState<{ id: string; name: string } | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  // The finished Klemmliste job (upload or Airtable).
  const [job, setJob] = useState<{ id: string; name: string; rows: KlemmlisteRow[]; warnings: string[] } | null>(null);
  const [deviceId, setDeviceId] = useState<number | ''>('');
  // Measuring units: the device picked per unit (none: the backend's order - first sensor numbers).
  const [unitDevices, setUnitDevices] = useState<Record<string, number | null> | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  // null: not chosen yet - the backend's suggestion is taken with the first preview.
  const [strategy, setStrategy] = useState<Strategy | null>(null);
  // Bumped when a mapping was written: the mapping panel reads again.
  const [mappingRevision, setMappingRevision] = useState(0);
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
        `${STATUS_URL}/airtable_documents/?location_id=${locationId}${projectQuery}${refresh ? '&refresh=1' : ''}`,
        (response) => {
          setDocuments((response?.data?.documents ?? []) as MeaDocument[]);
          setProjectFound(response?.data?.project_found !== false);
          setProjectUrl(response?.data?.project_url || response?.data?.airtable_url || null);
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
    [auth, locationId, projectQuery, staff],
  );

  useEffect(() => {
    fetchDocuments();
  }, [fetchDocuments]);

  const refreshDocuments = () => {
    setLoadingDocuments(true);
    fetchDocuments(true);
  };

  /** Read the documents of the project in the field ('' or the location's own number: its own). */
  const switchProject = (raw: string) => {
    const next = raw.trim() === String(locationId) ? '' : raw.trim();
    setProjectInput(next);
    if (next === projectNumber) {
      return;
    }
    setDocuments(null);
    setDocumentsError(null);
    setLoadingDocuments(true);
    setProjectNumber(next);
  };

  const download = async (document: MeaDocument) => {
    setDownloading(document.id);
    await downloadResponse(
      auth,
      `${STATUS_URL}/airtable_documents/download/?location_id=${locationId}&document=${encodeURIComponent(document.id)}${projectQuery}`,
      document.name,
    );
    setDownloading(null);
  };

  const readFromAirtable = (document: MeaDocument) => {
    setStarting(document.id);
    void axiosConfig.perform_post(
      auth,
      `${STATUS_URL}/klemmliste/`,
      { location_id: locationId, document: document.id, ...(projectNumber ? { project_number: projectNumber } : {}) },
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
    units: Record<string, number | null> | null,
    dryRun: boolean,
    onDone: (result: Preview) => void,
    onFail: (error: unknown) => void,
    chosen: Strategy | null = strategy,
  ) => {
    void axiosConfig.perform_post(
      auth,
      `${STATUS_URL}/klemmliste/apply/`,
      {
        location_id: locationId,
        job_id: jobId,
        device_id: device === '' ? null : device,
        ...(units ? { unit_devices: units } : {}),
        strategy: chosen ?? 'points',
        dry_run: dryRun,
      },
      (response) => onDone(response?.data?.result as Preview),
      onFail,
    );
  };

  /** What applying would change - after reading the list and when another device is picked. */
  const loadPreview = (
    jobId: string,
    device: number | '',
    units: Record<string, number | null> | null,
    chosen: Strategy | null = strategy,
  ) => {
    setPreviewing(true);
    setPreview(null);
    post(
      jobId,
      device,
      units,
      true,
      (result) => {
        // Nothing chosen yet: the suggestion - asked again when it is the other one.
        if (chosen === null && result.suggested_strategy && result.suggested_strategy !== 'points') {
          setStrategy(result.suggested_strategy);
          loadPreview(jobId, device, units, result.suggested_strategy);
          return;
        }
        if (chosen === null) {
          setStrategy('points');
        }
        setPreview(result);
        setPreviewing(false);
      },
      (error) => {
        setPreviewing(false);
        showRequestError(enqueueSnackbar, 'The Klemmliste could not be compared with the measure points', error);
      },
      chosen,
    );
  };

  const pickStrategy = (next: Strategy) => {
    setStrategy(next);
    if (job) {
      loadPreview(job.id, deviceId, unitDevices, next);
    }
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
    // A new list: its units go to the devices in order again, the strategy is suggested again.
    setUnitDevices(null);
    setStrategy(null);
    loadPreview(finished.job_id, deviceId, null, null);
  };

  const pickDevice = (device: number | '') => {
    setDeviceId(device);
    if (job) {
      loadPreview(job.id, device, unitDevices);
    }
  };

  /** Another device for a measuring unit - the others keep theirs. */
  const pickUnitDevice = (unit: string, device: number | null) => {
    const current = Object.fromEntries((preview?.units ?? []).map((entry) => [entry.unit, entry.device_id]));
    const next = { ...current, ...unitDevices, [unit]: device };
    setUnitDevices(next);
    if (job) {
      loadPreview(job.id, deviceId, next);
    }
  };

  const hasUnits = Boolean(job?.rows.some((row) => row.unit));

  const apply = () => {
    if (!job) {
      return;
    }
    setApplying(true);
    post(
      job.id,
      deviceId,
      unitDevices,
      false,
      (result) => {
        setApplying(false);
        // Applied: what it moved, mapped and named is now as the list says.
        const done = [...(result.moves ?? []), ...result.changes].map((entry) => ({ ...entry, from_order: undefined }));
        setPreview({
          ...result,
          mode: result.strategy === 'map' ? 'map' : 'name',
          moves: [],
          changes: [],
          device_updates: [],
          mappings: (result.mappings ?? []).map((mapping) => ({ ...mapping, changed: 0 })),
          unchanged: [...result.unchanged, ...done],
        });
        const mapped = (result.mappings ?? []).reduce((sum, mapping) => sum + mapping.positions.length, 0);
        showSuccessBar(
          enqueueSnackbar,
          result.strategy === 'map'
            ? `${mapped} input(s) mapped from now on, ${result.updated ?? 0} measure point(s) named`
            : `${result.updated ?? 0} measure point(s) ${result.moves?.length ? 'renumbered and ' : ''}named from the Klemmliste`,
        );
        if (result.strategy === 'map') {
          setMappingRevision((revision) => revision + 1);
        }
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
        <span className="lageplan-klemmliste-section-title">MEA documents and drawings (Airtable)</span>
        <span className="lageplan-klemmliste-actions">
          <Form
            className="lageplan-klemmliste-project"
            onSubmit={(event) => {
              event.preventDefault();
              switchProject(projectInput);
            }}
            data-testid="lageplan-wizard-mea-project"
          >
            <Form.Label htmlFor="lageplan-wizard-mea-project-number" className="lageplan-klemmliste-muted mb-0">
              Project number
            </Form.Label>
            <Form.Control
              id="lageplan-wizard-mea-project-number"
              size="sm"
              inputMode="numeric"
              value={projectInput}
              placeholder={String(locationId)}
              onChange={(event) => setProjectInput(event.target.value.replace(/\D/g, ''))}
              data-testid="lageplan-wizard-mea-project-number"
            />
            <PillButton
              variant="ghost"
              label="Load"
              onClick={() => switchProject(projectInput)}
              disabled={loadingDocuments || projectInput.trim() === projectNumber}
              testId="lageplan-wizard-mea-project-load"
            />
            {projectNumber && (
              <PillButton
                variant="ghost"
                label={`Own project (${locationId})`}
                onClick={() => switchProject('')}
                disabled={loadingDocuments}
                testId="lageplan-wizard-mea-project-own"
              />
            )}
          </Form>
          {projectUrl && (
            <a
              className="progeo-pill progeo-pill--ghost lageplan-klemmliste-link"
              href={projectUrl}
              target="_blank"
              rel="noopener noreferrer"
              title="Open the project in Airtable"
              data-testid="lageplan-wizard-mea-airtable-link"
            >
              <BoxArrowUpRight size={13} />
              Open in Airtable
            </a>
          )}
          <PillButton
            variant="ghost"
            icon={loadingDocuments ? <Spinner animation="border" size="sm" /> : <ArrowRepeat size={13} />}
            label="Refresh"
            onClick={refreshDocuments}
            disabled={loadingDocuments}
            testId="lageplan-wizard-mea-refresh"
          />
        </span>
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
          {projectNumber
            ? `No Airtable project with the number ${projectNumber}.`
            : 'No Airtable project for this location (project number or Airtable link).'}
        </div>
      ) : documents.length === 0 ? (
        <div className="lageplan-klemmliste-note" data-testid="lageplan-wizard-mea-empty">
          No CAD plan, Router_Daten.txt or PDF among the project&apos;s MEA documents and drawings.
        </div>
      ) : (
        GROUPS.map(({ group, label }) => {
          const inGroup = documents.filter((document) => groupOf(document) === group);
          return (
            <div key={group} className="lageplan-klemmliste-group" {...repeatedTestId('lageplan-wizard-mea-group', group)}>
              <div className="lageplan-klemmliste-group-title">{label}</div>
              {inGroup.length === 0 ? (
                <div className="lageplan-klemmliste-note">No CAD plan or PDF in {label}.</div>
              ) : (
                <ul className="lageplan-klemmliste-documents">
                  {inGroup.map((document) => (
                    <li key={document.id} {...repeatedTestId('lageplan-wizard-mea-document', document.id)}>
                      <Badge bg="light" text="dark" className="lageplan-klemmliste-kind">
                        {KIND_LABEL[document.kind]}
                      </Badge>
                      <span className="lageplan-klemmliste-name" title={document.name}>
                        {document.name}
                      </span>
                      <span className="lageplan-klemmliste-muted">{formatSize(document.size)}</span>
                      {(document.modified || document.created) && (
                        // When the record last changed in Airtable ("Name/Typ geändert"), else when it was added.
                        <span
                          className="lageplan-klemmliste-muted"
                          {...repeatedTestId('lageplan-wizard-mea-changed', document.id)}
                        >
                          {document.modified
                            ? `changed ${formatDate(document.modified, 'date')}`
                            : `added ${formatDate(document.created, 'date')}`}
                        </span>
                      )}
                      <span className="lageplan-klemmliste-actions">
                        {readable(document) && (
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
        })
      )}
    </div>
  );

  const mappingPanel = (
    <SensorMappingPanel
      auth={auth}
      locationId={locationId}
      devices={devices.map((device) => ({ id: device.id, label: device.label }))}
      staff={staff}
      revision={mappingRevision}
    />
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
              {devices.length > 1 && !hasUnits && (
                <Form.Select
                  size="sm"
                  className="lageplan-klemmliste-device"
                  value={deviceId}
                  onChange={(event) => pickDevice(event.target.value === '' ? '' : Number(event.target.value))}
                  aria-label="Device of the Klemmliste"
                  data-testid="lageplan-wizard-klemmliste-device"
                >
                  <option value="">
                    {strategy === 'map' ? 'Pick the device of the list' : 'Positions are the sensor numbers of the location'}
                  </option>
                  {devices.map((device) => (
                    <option key={device.id} value={device.id}>
                      {device.label} (from sensor {device.first_sensor_order ?? 1})
                    </option>
                  ))}
                </Form.Select>
              )}
              <PillButton
                icon={applying ? <Spinner animation="border" size="sm" /> : <ListCheck size={13} />}
                label={`Apply ${pendingCount(preview)} change(s)`}
                onClick={apply}
                disabled={applying || previewing || pendingCount(preview) === 0}
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
            <div className="lageplan-klemmliste-strategy" data-testid="lageplan-wizard-klemmliste-strategy">
              <Form.Check
                type="radio"
                inline
                id="klemmliste-strategy-points"
                name="klemmliste-strategy"
                checked={strategy === 'points'}
                disabled={previewing || applying}
                onChange={() => pickStrategy('points')}
                label="Renumber the points to their inputs (changes the past too)"
                data-testid="lageplan-wizard-klemmliste-strategy-points"
              />
              <Form.Check
                type="radio"
                inline
                id="klemmliste-strategy-map"
                name="klemmliste-strategy"
                checked={strategy === 'map'}
                disabled={previewing || applying}
                onChange={() => pickStrategy('map')}
                label="Sensor mapping - the points keep their numbers (from now on)"
                data-testid="lageplan-wizard-klemmliste-strategy-map"
              />
              {preview?.suggested_strategy === 'map' && strategy === 'points' && (
                <div className="lageplan-klemmliste-note lageplan-klemmliste-note--warning">
                  The location has measurements already: renumbering changes which point their values belong to.
                </div>
              )}
            </div>
            {preview?.strategy === 'map' &&
              (preview.mappings ?? []).map((mapping) => (
                <div
                  key={mapping.device_id}
                  className="lageplan-klemmliste-mapping"
                  {...repeatedTestId('lageplan-wizard-klemmliste-mapping', mapping.device_id)}
                >
                  <div>
                    {mapping.unit ? `${mapping.unit} → ` : ''}
                    <strong>{mapping.device_label}</strong>: <strong>{mapping.positions.length}</strong> input(s)
                    mapped, <strong>{mapping.remapped}</strong> differ from the formula
                    {mapping.changed > 0 ? `, ${mapping.changed} change from now on` : ', nothing changes'}.
                  </div>
                  {mapping.unmapped_inputs.length > 0 && (
                    <div className="lageplan-klemmliste-note" data-testid="lageplan-wizard-klemmliste-unmapped">
                      Inputs without sensor (left out, never alarm): {mapping.unmapped_inputs.join(', ')}
                    </div>
                  )}
                  {mapping.manual_conflicts.length > 0 && (
                    <div
                      className="lageplan-klemmliste-note lageplan-klemmliste-note--warning"
                      data-testid="lageplan-wizard-klemmliste-manual-conflicts"
                    >
                      Set by hand, kept:{' '}
                      {mapping.manual_conflicts
                        .map(
                          (conflict) =>
                            `input ${conflict.position} is sensor ${conflict.manual ?? 'none'} ` +
                            `(the list says ${conflict.klemmliste ?? 'none'})`,
                        )
                        .join('; ')}
                    </div>
                  )}
                </div>
              ))}
            {preview && (preview.units?.length ?? 0) > 0 && (
              <div className="lageplan-klemmliste-units" data-testid="lageplan-wizard-klemmliste-units">
                <div className="lageplan-klemmliste-note">
                  One list for {preview.units?.length} measuring units - each counts its MUX cards from 1 and goes to
                  one device (in the order of their first sensor number). Check the order and the sensor counts.
                </div>
                <Table size="sm" className="mb-0">
                  <thead>
                    <tr>
                      <th>Measuring unit</th>
                      <th>Device</th>
                      <th>Sensors in the list</th>
                      <th>Device measures</th>
                      <th>Sensor numbers</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.units?.map((unit) => (
                      <tr
                        key={unit.unit}
                        className={
                          unit.device_id == null || unit.count_matches === false
                            ? 'lageplan-klemmliste-unit lageplan-klemmliste-unit--warning'
                            : 'lageplan-klemmliste-unit'
                        }
                        {...repeatedTestId('lageplan-wizard-klemmliste-unit', unit.unit)}
                      >
                        <td>{unit.unit}</td>
                        <td>
                          <Form.Select
                            size="sm"
                            value={unit.device_id ?? ''}
                            onChange={(event) =>
                              pickUnitDevice(unit.unit, event.target.value === '' ? null : Number(event.target.value))
                            }
                            aria-label={`Device of ${unit.unit}`}
                            {...repeatedTestId('lageplan-wizard-klemmliste-unit-device', unit.unit)}
                          >
                            <option value="">– none (left out) –</option>
                            {devices.map((device) => (
                              // The id too: the controllers of a location are often all "smartex dm".
                              <option key={device.id} value={device.id}>
                                {device.label} #{device.id} (now from sensor {device.first_sensor_order ?? 1})
                              </option>
                            ))}
                          </Form.Select>
                        </td>
                        <td>{unit.rows}</td>
                        <td>
                          {unit.sensor_count == null ? (
                            <span className="lageplan-klemmliste-muted">unknown</span>
                          ) : unit.count_matches ? (
                            <span>{unit.sensor_count} ✓</span>
                          ) : (
                            <strong>{unit.sensor_count} ≠ {unit.rows}</strong>
                          )}
                        </td>
                        <td>
                          {unit.device_id == null
                            ? '–'
                            : `${unit.first_sensor_order}–${unit.last_sensor_order ?? unit.first_sensor_order}`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
                {preview.rows_total != null && preview.point_orders && (
                  <div
                    className={
                      preview.rows_total === preview.point_orders.count
                        ? 'lageplan-klemmliste-note'
                        : 'lageplan-klemmliste-note lageplan-klemmliste-note--warning'
                    }
                    data-testid="lageplan-wizard-klemmliste-total"
                  >
                    {preview.rows_total} sensor(s) in the list, {preview.point_orders.count} measure point(s) at the
                    location {preview.rows_total === preview.point_orders.count ? '✓' : '- they differ'}
                  </div>
                )}
                {(preview.device_updates?.length ?? 0) > 0 && (
                  <ul className="lageplan-klemmliste-device-updates" data-testid="lageplan-wizard-klemmliste-device-updates">
                    {preview.device_updates?.map((update) => (
                      <li key={update.device_id} {...repeatedTestId('lageplan-wizard-klemmliste-device-update', update.device_id)}>
                        {update.unit} → {update.device_label}:{' '}
                        {update.first_sensor_order[0] !== update.first_sensor_order[1] &&
                          `first sensor ${update.first_sensor_order[0]} → ${update.first_sensor_order[1]}`}
                        {update.first_sensor_order[0] !== update.first_sensor_order[1] &&
                          update.sensor_count[0] !== update.sensor_count[1] &&
                          ', '}
                        {update.sensor_count[0] !== update.sensor_count[1] &&
                          `sensor count ${update.sensor_count[0] ?? '–'} → ${update.sensor_count[1]}`}
                      </li>
                    ))}
                  </ul>
                )}
                {(preview.unit_warnings?.length ?? 0) > 0 && (
                  <ul className="lageplan-klemmliste-warnings" data-testid="lageplan-wizard-klemmliste-unit-warnings">
                    {preview.unit_warnings?.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {preview?.mode === 'renumber' && (preview.moves?.length ?? 0) > 0 && (
              <div className="lageplan-klemmliste-note" data-testid="lageplan-wizard-klemmliste-renumber">
                The measure points are numbered by their plan label (e.g. D_124 is point 124). Applying moves
                each one to its input - sensor number (MUX - 1) × 16 + PIN - and names it, so the plan shows the
                readings of the right input. Points not in the list keep their number.
              </div>
            )}
            {preview && (preview.conflicts?.length ?? 0) > 0 && (
              <div
                className="lageplan-klemmliste-note lageplan-klemmliste-note--warning"
                data-testid="lageplan-wizard-klemmliste-conflicts"
              >
                {preview.conflicts?.length} sensor(s) can&apos;t move: their input&apos;s number is taken by a point the
                list doesn&apos;t move away. They stay as they are.
              </div>
            )}
            {preview && preview.missing.length > 0 && preview.point_orders && preview.mode !== 'renumber' && (
              <div
                className="lageplan-klemmliste-note lageplan-klemmliste-note--warning"
                data-testid="lageplan-wizard-klemmliste-mismatch"
              >
                {preview.missing.length} position(s) have no measure point with that sensor number.{' '}
                {preview.point_orders.count === 0
                  ? 'The location has no measure points yet - import or place them first.'
                  : `The location's ${preview.point_orders.count} measure point(s) are numbered ` +
                    `${preview.point_orders.min}–${preview.point_orders.max}.`}
                {(preview.named_like_points ?? 0) > 0 &&
                  ` ${preview.named_like_points} sensor name(s) end in the number of an existing point ` +
                    '(e.g. D_124 and point 124): the points are numbered by their plan label, not by MUX/PIN.'}
              </div>
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
                      {hasUnits && <th>Unit</th>}
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
                        key={lineKey(line)}
                        className={`lageplan-klemmliste-line lageplan-klemmliste-line--${line.state}`}
                        {...repeatedTestId('lageplan-wizard-klemmliste-line', lineKey(line))}
                      >
                        {hasUnits && <td>{line.unit ?? '–'}</td>}
                        <td>{line.position}</td>
                        <td>{line.mux != null ? `${line.mux} / ${line.pin}` : '–'}</td>
                        <td>{line.new}</td>
                        <td>
                          {line.state === 'missing'
                            ? line.sensor_order == null
                              ? 'no point of that name'
                              : `#${line.sensor_order} – none`
                            : line.state === 'move' || line.state === 'conflict'
                              ? `#${line.from_order} → #${line.sensor_order}`
                              : `#${line.sensor_order}`}
                        </td>
                        <td>
                          {line.state === 'move' && (
                            <span>
                              {line.old || '(no name)'} → {line.new}, number {line.from_order} → {line.sensor_order}
                            </span>
                          )}
                          {line.state === 'conflict' && (
                            <span className="lageplan-klemmliste-muted">number {line.sensor_order} is taken</span>
                          )}
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
      {mappingPanel}
    </div>
  );
};

export default LageplanKlemmliste;
