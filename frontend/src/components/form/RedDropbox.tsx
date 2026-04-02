import { LinearProgress } from '@mui/material';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Col, Form, Row } from 'react-bootstrap';
import axiosConfig from '../../axiosConfig';
import { useDropzone } from 'react-dropzone';
import { Thumbnail } from '../ui/GalleryHelper.tsx';
import { showErrorBar, showSuccessBar } from '../ui/Snackbar.jsx';
import { getAcceptesTypes } from '../datatables/configs.jsx';
import { useSnackbar } from 'notistack';
import { defaultErrorCallback } from '../../helper.jsx';

export interface IPreview {
  src: string;
  width: string;
  name?: string;
  alt: string;
}

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
}) => {
  const _types = getAcceptesTypes(accept);
  const [progress, setProgress] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [previews, setPreviews] = useState<IPreview[]>([]);
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
      showErrorBar(enqueueSnackbar, `Rejected! ${error && error}`);
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

  const baseStyle = {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    padding: '20px',
    marginTop: '5px',
    borderWidth: 2,
    borderTopLeftRadius: 8,
    borderTopRightRadius: 8,
    borderColor: '#eeeeee',
    borderStyle: 'dashed',
    backgroundColor: '#fafafa',
    color: '#bdbdbd',
    outline: 'none',
    transition: 'border .24s ease-in-out',
  };

  const focusedStyle = {
    borderColor: '#2196f3',
  };

  const acceptStyle = {
    borderColor: '#00e676',
  };

  const rejectStyle = {
    borderColor: '#ff1744',
  };

  const style = useMemo(
    () => ({
      ...baseStyle,
      ...(isFocused ? focusedStyle : {}),
      ...(isDragAccept ? acceptStyle : {}),
      ...(isDragReject ? rejectStyle : {}),
    }),
    [isFocused, isDragAccept, isDragReject],
  );

  const handleFiles = useCallback(
    (list: FileList | null) => {
      setError(null);
      if (!list || list.length === 0) {
        return;
      }

      const valid: File[] = [];
      for (const f of Array.from(list)) {
        if (accept && !matchesAccept(f, Object.keys(_types))) {
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
    [accept],
  );

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
    if (acceptedFiles.length) {
      const formData = new FormData();
      acceptedFiles.map((file, index) => {
        formData.append(`files${index}`, file, file.name);
      });

      if (instantFileUpload) {
        uploadFile(url, formData);
      } else {
        callBackProcessing(formData);
      }
    }
  }, [acceptedFiles]);

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
      defaultErrorCallback,
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
          <div {...getRootProps({ style })}>
            <input {...getInputProps()} />
            <p>
              Drag &apos;n&apos; drop some files here, or click to select files
            </p>
          </div>
          <LinearProgress
            style={{
              height: 10,
              borderBottomLeftRadius: 8,
              borderBottomRightRadius: 8,
              marginBottom: 20,
            }}
            variant="determinate"
            value={progress}
            color={'success'}
          />
        </Col>
      </Row>
      <Row>
        <Col className={'mt-3'}>
          {error && <div className="text-danger">{error}</div>}
          {withPreview &&
            previews.length > 0 &&
            previews.map((preview: IPreview, i) => (
              <Thumbnail
                src={preview.src}
                width={'250px'}
                alt={`preview-${i}`}
              />
            ))}
        </Col>
      </Row>
    </Form.Group>
  );
};
export default RedDropbox;
