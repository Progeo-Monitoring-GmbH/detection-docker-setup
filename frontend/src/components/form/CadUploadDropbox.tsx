import { LinearProgress } from '@mui/material';
import { useSnackbar } from 'notistack';
import { type ComponentProps, useEffect, useRef } from 'react';
import { showErrorBar, showSuccessBar } from '../ui/Snackbar.jsx';
import RedDropbox from './RedDropbox.tsx';
import useCadImportJob, { type CadImportJob } from './useCadImportJob.ts';

type Props = ComponentProps<typeof RedDropbox>;

const STATUS_TEXT: Record<CadImportJob['status'], string> = {
  queued: 'Waiting for a worker…',
  running: 'Converting and reading the CAD file…',
  done: 'Import finished',
  failed: 'Import failed',
};

/**
 * RedDropbox for measure_points/upload_cad: a DWG/DXF upload is answered with
 * a job (progeo/helper/cad_import.py) - its log is shown live while
 * progeo-cad_factory runs, and callBackProcessing gets the job's result, the
 * same answer a text upload gets right away.
 */
const CadUploadDropbox = ({ callBackProcessing = () => {}, ...props }: Props) => {
  const { enqueueSnackbar } = useSnackbar();
  const logRef = useRef<HTMLPreElement | null>(null);

  const { job, follow, running } = useCadImportJob(props.auth, (finished) => {
    if (finished.status === 'done' && finished.result) {
      showSuccessBar(enqueueSnackbar, `CAD import finished: ${finished.result.stored ?? 0} point(s)`);
      callBackProcessing(finished.result);
    } else {
      showErrorBar(enqueueSnackbar, `CAD import failed: ${finished.error || 'unknown error'}`);
    }
  });

  // Keep the newest line in view.
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [job?.log.length]);

  const handleResponse = (data) => {
    if (typeof data?.job_id === 'string') {
      follow(data.job_id);
      return;
    }
    callBackProcessing(data);
  };

  return (
    <>
      <RedDropbox {...props} callBackProcessing={handleResponse} />
      {job && (
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
            {job.source_name ? ` - ${job.source_name}` : ''}
          </div>
          {running && <LinearProgress style={{ height: 4, borderRadius: 2, marginBottom: 4 }} />}
          <pre
            ref={logRef}
            style={{
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
            }}
          >
            {job.log.length ? job.log.join('\n') : 'Waiting for output…'}
          </pre>
          {job.status === 'failed' && job.error && (
            <div style={{ fontSize: 12, color: '#C44D26', marginTop: 4 }}>{job.error}</div>
          )}
        </div>
      )}
    </>
  );
};

export default CadUploadDropbox;
