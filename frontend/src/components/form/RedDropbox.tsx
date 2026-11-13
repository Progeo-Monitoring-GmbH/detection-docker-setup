import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Col, Form, ProgressBar, Row } from 'react-bootstrap';
import axiosConfig, { defaultErrorCallback } from '../../axiosConfig';
import { useDropzone, type Accept } from 'react-dropzone';
import { IPreview, Thumbnail } from '../ui/GalleryHelper.tsx';
import {
  showErrorBar,
  showRequestError,
  showSuccessBar,
} from '../ui/Snackbar.jsx';
import { useSnackbar } from 'notistack';
import { childTestId } from '../../testIds';
import './RedDropbox.css';

// Typed as Accept: the inferred union of the literals gives every branch
// the other branches' keys as `?: undefined`, which useDropzone rejects.
const getAcceptesTypes = (kind: string): Accept => {
  const key = (kind || '').toLowerCase();
  if (key === 'cad') {
    return {
      'image/vnd.dwg': ['.dwg'],
      'application/octet-stream': ['.dwg', '.dxf'],
      'application/x-autocad': ['.dwg'],
      'application/acad': ['.dwg'],
      'application/dxf': ['.dxf'],
      'application/x-dxf': ['.dxf'],
    };
  }
  if (key === 'image') {
    return { 'image/*': [] };
  }
  if (key === 'pdf') {
    return { 'application/pdf': ['.pdf'] };
  }
  if (key === 'json') {
    return { 'application/json': ['.json'] };
  }
  return { '*/*': [] };
};

const RedDropbox = ({
  auth,
  url,
  accept = 'doc',
  callBackProcessing = (_) => {},
  maxSizeMB = 5,
  withPreview = false,
  instantFileUpload = true,
  token = '',
  refreshed = undefined,
  payload = {},
  hint = 'Drag & drop some files here, or click to select files',
  // data-testid of the drop zone; its parts are "<testId>-input", "-progress", "-error", "-preview".
  testId = 'dropzone',
}) => {
  const _types = useMemo(() => getAcceptesTypes(accept), [accept]);
  const [progress, setProgress] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [previews, setPreviews] = useState<IPreview[]>([]);
  const processedUploadRef = useRef('');
  const { enqueueSnackbar } = useSnackbar();

  const maxBytes = maxSizeMB * 1024 * 1024;

  const dropzoneOptions = {
    accept: _types,
    capture: 'environment',
    maxSize: maxBytes,
    onDrop: (acceptedFiles) => {
      console.log('Files dropped:', acceptedFiles);
      setProgress(0);
      handleFiles(acceptedFiles);
    },
    onDropRejected: (fileRejections) => {
      console.log('Rejected files:', fileRejections);
      const reasons = fileRejections
        .map(
          ({ file, errors }) =>
            `${file.name}: ${errors.map((e) => e.message).join(', ')}`,
        )
        .join('; ');
      showErrorBar(enqueueSnackbar, `Rejected! ${reasons}`);
    },
  };

  let acceptedFiles,
    getRootProps,
    getInputProps,
    isFocused,
    isDragAccept,
    isDragReject;
  ({
    acceptedFiles,
    getRootProps,
    getInputProps,
    isFocused,
    isDragAccept,
    isDragReject,
  } = useDropzone(dropzoneOptions));

  // The look of each drag state: RedDropbox.css.
  const className = [
    'red-dropbox',
    isFocused ? 'red-dropbox--focused' : '',
    isDragAccept ? 'red-dropbox--accept' : '',
    isDragReject ? 'red-dropbox--reject' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const handleFiles = useCallback(
    (list: FileList | null) => {
      setError(null);
      if (!list || list.length === 0) {
        return;
      }

      const valid: File[] = [];
      for (const f of Array.from(list)) {
        // MIME types and extensions: browsers give e.g. .dwg no MIME type.
        const parts = [
          ...Object.keys(_types),
          ...Object.values(_types).flat(),
        ];
        if (accept && !matchesAccept(f, parts)) {
          setError(`Unsupported file type: ${f.type || f.name}`);
          continue;
        }
        if (f.size > maxBytes) {
          setError(
            `File too large: ${(f.size / 1024 / 1024).toFixed(1)} MB (max ${maxSizeMB} MB)`,
          );
          continue;
        }
        valid.push(f);
      }

      if (valid.length) {
        const urls = valid.map(
          (f) =>
            ({
              src: URL.createObjectURL(f),
              name: f.name,
            }) as IPreview,
        );
        setPreviews(urls);
      }
    },
    [accept, _types, maxBytes, maxSizeMB],
  );

  const appendPayloadToFormData = (formData: FormData) => {
    const source = payload ?? {};
    if (!Object.keys(source).length) {
      return formData;
    }

    Object.entries(source).forEach(([key, value]) => {
      if (value === undefined || value === null) {
        return;
      }

      if (typeof value === 'object') {
        formData.append(key, JSON.stringify(value));
        return;
      }

      formData.append(key, String(value));
    });

    return formData;
  };

  function matchesAccept(file: File, parts: string[]) {
    const type = file.type.toLowerCase();
    const name = file.name.toLowerCase();

    for (const p of parts) {
      if (p === '*/*') {
        return true;
      }
      if (p.endsWith('/*')) {
        const prefix = p.split('/')[0];
        if (type.startsWith(prefix + '/')) {
          return true;
        }
      } else if (p.startsWith('.')) {
        if (name.endsWith(p)) {
          return true;
        }
      } else {
        if (type === p) {
          return true;
        }
      }
    }
    return false;
  }

  useEffect(() => {
    if (!acceptedFiles.length) {
      processedUploadRef.current = '';
      return;
    }

    const filesSignature = acceptedFiles
      .map((file) => `${file.name}:${file.size}:${file.lastModified}`)
      .join('|');
    const uploadSignature = `${filesSignature}:${JSON.stringify(payload ?? {})}`;
    if (processedUploadRef.current === uploadSignature) {
      return;
    }

    processedUploadRef.current = uploadSignature;
    const formData = new FormData();
    acceptedFiles.forEach((file, index) => {
      formData.append(`files${index}`, file, file.name);
    });

    appendPayloadToFormData(formData);

    if (instantFileUpload) {
      uploadFile(url, formData);
    } else {
      callBackProcessing(formData);
    }
    // Per new files/payload only (processedUploadRef guards repeats): the
    // callbacks and url are new on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [acceptedFiles, payload]);

  useEffect(() => {
    if (refreshed) {
      setPreviews([]);
    }
  }, [refreshed]);

  async function uploadFile(url: string, formData: FormData) {
    const headers = {
      'Content-Type': 'multipart/form-data',
    };
    if (token) {
      headers['Authorization'] = `Token ${token}`;
    }

    appendPayloadToFormData(formData);
    if (Object.keys(payload).length) {
      formData.append('payload', JSON.stringify(payload));
    }

    await axiosConfig.perform_post(
      auth,
      url,
      formData,
      (response) => {
        if (response.data.success) {
          showSuccessBar(enqueueSnackbar, 'Successfully uploaded File');
          callBackProcessing(response.data);
          setProgress(0);
        } else {
          showErrorBar(enqueueSnackbar, 'Failed uploading!');
        }
      },
      (requestError) => {
        defaultErrorCallback(requestError);
        showRequestError(enqueueSnackbar, 'Upload failed', requestError);
        setProgress(0);
      },
      {
        headers: headers,
        onUploadProgress: (event) => {
          if (!event.total) {
            return;
          }
          const percent = Math.round((event.loaded * 100) / event.total);
          setProgress(percent);
        },
      },
    );
  }

  return (
    <Form.Group controlId="formValue">
      <Row>
        <Col>
          <div {...getRootProps({ className })} data-testid={testId}>
            <input {...getInputProps()} data-testid={childTestId(testId, 'input')} />
            <span>{hint}</span>
          </div>
          {/* Only while a file is on its way - no empty bar under the box. */}
          {progress > 0 && (
            <ProgressBar
              now={progress}
              variant="success"
              className="red-dropbox-progress"
              data-testid={childTestId(testId, 'progress')}
            />
          )}
        </Col>
      </Row>
      {(error || (withPreview && previews.length > 0)) && (
        <Row>
          <Col className={'mt-2'}>
            {error && (
              <div className="text-danger small" data-testid={childTestId(testId, 'error')}>
                {error}
              </div>
            )}
            {withPreview &&
              previews.length > 0 &&
              previews.map((preview: IPreview, i) => (
                <Thumbnail
                  key={`${i}-${preview.src}`}
                  src={preview.src}
                  width={'250px'}
                  alt={`preview-${i}`}
                  testId={childTestId(testId, 'preview')}
                />
              ))}
          </Col>
        </Row>
      )}
    </Form.Group>
  );
};
export default RedDropbox;
