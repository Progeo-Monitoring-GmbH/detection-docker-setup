import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Printer } from 'react-bootstrap-icons';
import axiosConfig from '../axiosConfig';
import { useAuth } from '../../hooks/CoreAuthProvider';
import PillButton from '../components/ui/kit/PillButton';
import { repeatedTestId } from '../testIds';
import './ControllerQrCodePrintView.css';

type QrCode = {
  payload: string;
  image: string;
};

type ControllerQrCodes = {
  wifi: QrCode & { ssid: string };
  frontend: QrCode & { url: string };
};

// The page margin only while this sheet is shown - a stylesheet import would
// keep it for every page printed later. The rest: ControllerQrCodePrintView.css.
const PRINT_CSS = `
@page { margin: 1cm; }
`;

/**
 * Printable sheet with the controller QR codes from
 * /v1/<account>/setup/controller/qrcodes/: one joins the controller Wi-Fi,
 * one opens its frontend. Rendered outside the app layout (no sidebar) so
 * the browser's print output only contains the codes.
 */
const ControllerQrCodePrintView = () => {
  const { account } = useParams();
  const auth = useAuth();
  const { t } = useTranslation();
  const [codes, setCodes] = useState<ControllerQrCodes | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    void axiosConfig.perform_get(
      auth,
      `/v1/${account}/setup/controller/qrcodes/`,
      (response) => setCodes(response.data as ControllerQrCodes),
      (err) =>
        setError(err?.response?.data?.reason || t('qrprint_load_failed')),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account]);

  const card = (kind: 'wifi' | 'frontend', title: string, caption: string, code: QrCode) => (
    <figure className="qr-print-card" {...repeatedTestId('controller-qrcodes-card', kind)}>
      <img
        src={code.image}
        alt={title}
        className="qr-print-code"
      />
      <figcaption className="qr-print-caption">
        <strong>{title}</strong>
        <br />
        {caption}
      </figcaption>
    </figure>
  );

  return (
    <div className="qr-print-page" data-testid="page-controller-qrcodes">
      <style>{PRINT_CSS}</style>
      <div className="qr-print-actions">
        <PillButton
          label={t('qrprint_print')}
          icon={<Printer size={14} />}
          onClick={() => window.print()}
          testId="controller-qrcodes-print"
          disabled={!codes}
        />
      </div>
      {error && <p className="qr-print-error" data-testid="controller-qrcodes-error">{error}</p>}
      {!codes && !error && <p data-testid="controller-qrcodes-loading">{t('devcfg_loading')}</p>}
      {codes && (
        <div className="qr-print-codes" data-testid="controller-qrcodes-list">
          {card('wifi', t('qrprint_wifi'), codes.wifi.ssid, codes.wifi)}
          {card('frontend', t('qrprint_frontend'), codes.frontend.url, codes.frontend)}
        </div>
      )}
    </div>
  );
};

export default ControllerQrCodePrintView;
