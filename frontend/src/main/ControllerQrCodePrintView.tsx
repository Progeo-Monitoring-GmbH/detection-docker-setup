import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Printer } from 'react-bootstrap-icons';
import axiosConfig from '../axiosConfig';
import { useAuth } from '../../hooks/CoreAuthProvider';
import PillButton from '../components/ui/kit/PillButton';

type QrCode = {
  payload: string;
  image: string;
};

type ControllerQrCodes = {
  wifi: QrCode & { ssid: string };
  frontend: QrCode & { url: string };
};

// Printed edge length of each code (incl. the quiet zone of the PNG).
const QR_SIZE = '6cm';

const PRINT_CSS = `
@page { margin: 1cm; }
@media print {
  .qr-print-actions { display: none !important; }
  .qr-print-page { padding: 0 !important; background: #fff !important; }
}
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

  const card = (title: string, caption: string, code: QrCode) => (
    <figure
      style={{
        margin: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '0.2cm',
        breakInside: 'avoid',
      }}
    >
      <img
        src={code.image}
        alt={title}
        style={{
          width: QR_SIZE,
          height: QR_SIZE,
          imageRendering: 'pixelated',
        }}
      />
      <figcaption style={{ textAlign: 'center', fontSize: '10pt' }}>
        <strong>{title}</strong>
        <br />
        {caption}
      </figcaption>
    </figure>
  );

  return (
    <div
      className="qr-print-page"
      style={{
        minHeight: '100vh',
        background: '#fff',
        color: '#000',
        padding: 24,
      }}
    >
      <style>{PRINT_CSS}</style>
      <div className="qr-print-actions" style={{ marginBottom: 24 }}>
        <PillButton
          label={t('qrprint_print')}
          icon={<Printer size={14} />}
          onClick={() => window.print()}
          disabled={!codes}
        />
      </div>
      {error && <p style={{ color: 'var(--progeo-orange)' }}>{error}</p>}
      {!codes && !error && <p>{t('devcfg_loading')}</p>}
      {codes && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1.5cm' }}>
          {card(t('qrprint_wifi'), codes.wifi.ssid, codes.wifi)}
          {card(t('qrprint_frontend'), codes.frontend.url, codes.frontend)}
        </div>
      )}
    </div>
  );
};

export default ControllerQrCodePrintView;
