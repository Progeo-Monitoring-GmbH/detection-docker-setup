import { useContext, useEffect, useState } from 'react';
import { Button, Col, Form, Modal, Row } from 'react-bootstrap';
import { CoreModalContext } from './coreModalContext';
import axiosConfig from '../../axiosConfig';
import { useAuth } from '../../../hooks/CoreAuthProvider';
import RedDropbox from '../form/RedDropbox.tsx';
import { defaultErrorCallback } from '../../helper.jsx';

interface QrCodeState {
  image?: string;
  success?: boolean;
  url?: string;
}

const UploadDocumentModal = ({
  account,
  accept = 'doc',
  callBackUploaded = (_) => {},
}) => {
  const [show, setShow] = useContext(CoreModalContext);
  const [qrCode, setQrCode] = useState<QrCodeState>({});
  const auth = useAuth();

  useEffect(() => {
    if (show.modalUploadDocument) {
    }
  }, [show]);

  const generateQRCode = async () => {
    await axiosConfig.perform_post(
      auth,
      `/v1/${account}/qrcode/generate/`,
      {
        url: `${import.meta.env.VITE_FRONTEND_URL}/main/${account}/anon/${show.modal}/${show.modal_id}/upload/`,
        id: show?.data?.id || -1,
      },
      (response) => {
        if (response.data.success) {
          setQrCode(response.data);
          console.log('==>', response.data.url);
        }
      },
      defaultErrorCallback,
    );
  };

  const handleClose = () => {
    setShow((show) => ({ ...show, modalUploadDocument: false }));
    setQrCode({});
  };

  return (
    <Form>
      <Modal
        show={show.modalUploadDocument}
        onHide={handleClose}
        dialogClassName={'wide-modal'}
      >
        <Modal.Header>
          <Modal.Title>{show.title}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Row>
            {show?.withQR && (
              <>
                <Col>
                  <Form.Group controlId="formValue" className={'pb-4'}>
                    {qrCode?.success ? (
                      <>
                        Scan to upload via phone!
                        <br />
                        <input
                          value={qrCode.url}
                          id={'qrCodeUrl'}
                          className={'w-75'}
                          onClick={() => {
                            const input = document.getElementById(
                              'qrCodeUrl',
                            ) as HTMLInputElement;
                            input.select();
                          }}
                          readOnly={true}
                        />
                        <img
                          src={qrCode.image}
                          width={350}
                          alt={'Upload-Link'}
                        />
                      </>
                    ) : (
                      <Button
                        className={'w-100'}
                        onClick={() => generateQRCode()}
                      >
                        Generate QR-Code
                      </Button>
                    )}
                  </Form.Group>
                </Col>
                <Col md={1}>
                  <div className="d-flex h-100">
                    <div className="vr" />
                  </div>
                </Col>
              </>
            )}

            <Col>
              <RedDropbox
                auth={auth}
                url={`/v1/${account}/${show.modal}/${show.modal_id}/upload/${show.modal_path}/`}
                accept={accept}
                callBackProcessing={(data) => {
                  callBackUploaded(data);
                  handleClose();
                }}
                withPreview={false}
              />
            </Col>
          </Row>
        </Modal.Body>

        <Modal.Footer>
          <Button variant="secondary" onClick={handleClose}>
            Close
          </Button>
        </Modal.Footer>
      </Modal>
    </Form>
  );
};
export default UploadDocumentModal;
