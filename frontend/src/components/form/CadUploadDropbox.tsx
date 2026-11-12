import { ProgressBar } from 'react-bootstrap';
import { useSnackbar } from 'notistack';
import { type ComponentProps, useEffect, useRef, useState } from 'react';
import { showErrorBar, showSuccessBar } from '../ui/Snackbar.jsx';
import RedDropbox from './RedDropbox.tsx';
import useCadImportJob, { type CadImportJob } from './useCadImportJob.ts';

type Props = ComponentProps<typeof RedDropbox>;

const STATUS_TEXT: Record<CadImportJob['status'], string> = {
  queued: 'Waiting for a worker…',
  running: 'Reading the file…',
  done: 'Import finished',
  failed: 'Import failed',
};

const LOG_STYLE = {
  background: '#101419',
  color: '#d9e2ec',
  borderRadius: 12,
  padding: '10px 12px',
  maxHeight: 240,
  margin: 0,
  overflow: 'auto',
  fontSize: 12,
  lineHeight: 1.5,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
} as const;

type FollowedJob = { id: string; name?: string };

/**
 * One import job, followed live (useCadImportJob): its status, the log and
 * an error. `compact` (several jobs at once): one line each, the log folded.
 */
const CadJobView = ({
  auth,
  jobId,
  name,
  compact,
  onFinished,
}: {
  auth: Props['auth'];
  jobId: string;
  name?: string;
  compact: boolean;
  onFinished: (job: CadImportJob) => void;
}) => {
  const logRef = useRef<HTMLPreElement | null>(null);
  const { job, follow, running } = useCadImportJob(auth, onFinished);

  useEffect(() => {
    follow(jobId);
  }, [follow, jobId]);

  // Keep the newest line in view.
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [job?.log.length]);

  if (!job) {
    return null;
  }
  const source = job.source_name || name;
  const log = (
    <pre ref={logRef} style={LOG_STYLE}>
      {job.log.length ? job.log.join('\n') : 'Waiting for output…'}
    </pre>
  );
  return (
    <div style={{ marginTop: 8 }}>
      <div
        style={{
          fontSize: 12,
          fontWeight: 600,
          marginBottom: 4,
          color: job.status === 'failed' ? '#C44D26' : 'inherit',
        }}
      >
        {STATUS_TEXT[job.status]}
        {source ? ` - ${source}` : ''}
      </div>
      {/* Indeterminate: the import reports no percentage. */}
      {running && <ProgressBar animated striped now={100} style={{ height: 4, marginBottom: 4 }} />}
      {compact ? (
        <details>
          <summary style={{ fontSize: 12, cursor: 'pointer' }}>Log ({job.log.length} lines)</summary>
          {log}
        </details>
      ) : (
        log
      )}
      {job.status === 'failed' && job.error && (
        <div style={{ fontSize: 12, color: '#C44D26', marginTop: 4 }}>{job.error}</div>
      )}
    </div>
  );
};

/**
 * RedDropbox for measure_points/upload_cad and from_pdf: a DWG/DXF/PDF upload
 * is answered with a job, from_pdf with one job per PDF (progeo/helper/
 * cad_import.py) - they run side by side on the server; each one's log is
 * shown live, and callBackProcessing gets every job's result as it finishes,
 * the same answer a text (upload_cad) or PNG (upload_png) upload gets right
 * away.
 */
const CadUploadDropbox = ({ callBackProcessing = () => {}, ...props }: Props) => {
  const { enqueueSnackbar } = useSnackbar();
  const [jobs, setJobs] = useState<FollowedJob[]>([]);
  // How each followed job ended - a new upload drops the finished ones.
  const [outcomes, setOutcomes] = useState<Record<string, CadImportJob['status']>>({});
  const finishedRef = useRef(new Set<string>());

  const handleFinished = (finished: CadImportJob) => {
    finishedRef.current.add(finished.job_id);
    setOutcomes((current) => ({ ...current, [finished.job_id]: finished.status }));
    const source = finished.source_name ? ` (${finished.source_name})` : '';
    if (finished.status === 'done' && finished.result) {
      showSuccessBar(
        enqueueSnackbar,
        finished.kind === 'lageplan'
          ? `Lageplan created from the PDF${source}`
          : `CAD import finished: ${finished.result.stored ?? 0} point(s)`,
      );
      callBackProcessing(finished.result);
    } else {
      showErrorBar(enqueueSnackbar, `Import failed${source}: ${finished.error || 'unknown error'}`);
    }
  };

  const handleResponse = (data) => {
    const started: FollowedJob[] | null = Array.isArray(data?.jobs)
      ? data.jobs
          .filter((job) => typeof job?.job_id === 'string')
          .map((job) => ({ id: job.job_id, name: job.source_name }))
      : typeof data?.job_id === 'string'
        ? [{ id: data.job_id }]
        : null;
    if (started) {
      // Jobs still running stay followed - their plans still arrive.
      setJobs((current) => [...current.filter((job) => !finishedRef.current.has(job.id)), ...started]);
      return;
    }
    callBackProcessing(data);
  };

  const done = jobs.filter((job) => outcomes[job.id]).length;
  const failed = jobs.filter((job) => outcomes[job.id] === 'failed').length;
  const compact = jobs.length > 1;

  return (
    <>
      <RedDropbox {...props} callBackProcessing={handleResponse} />
      {compact && (
        <div style={{ fontSize: 12, fontWeight: 600, marginTop: 8 }}>
          {done} of {jobs.length} files done{failed ? ` · ${failed} failed` : ''}
        </div>
      )}
      {jobs.map((job) => (
        <CadJobView
          key={job.id}
          auth={props.auth}
          jobId={job.id}
          name={job.name}
          compact={compact}
          onFinished={handleFinished}
        />
      ))}
    </>
  );
};

export default CadUploadDropbox;
